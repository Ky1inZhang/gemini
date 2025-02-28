import { Buffer } from "node:buffer";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = async (err) => {
      console.error(err);
      if (err instanceof Response) {
        // 如果是Response对象，直接转发原始错误响应
        const responseHeaders = new Headers(err.headers);
        responseHeaders.set("Content-Type", "application/json");
        return new Response(err.body, fixCors({
          headers: responseHeaders,
          status: err.status,
          statusText: err.statusText
        }));
      }
      // 对于其他类型的错误，返回500错误
      return new Response(JSON.stringify({
        error: {
          code: 500,
          message: err.message || "Internal server error",
          status: "INTERNAL"
        }
      }), fixCors({
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      if (!apiKey) {
        throw new HttpError("Missing API key", 401);
      }
      const { pathname } = new URL(request.url);
      
      // 直接转发请求到Gemini API
      const targetUrl = `${BASE_URL}${pathname}`;
      const headers = makeHeaders(apiKey, { "Content-Type": "application/json" });

      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "POST" ? await request.text() : undefined
      });

      // 如果响应不成功，将其作为错误抛出
      if (!response.ok) {
        throw response;
      }

      let { body } = response;
      if (response.ok && pathname.endsWith("/chat/completions")) {
        const req = await request.json();
        if (req.stream) {
          body = response.body
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new TransformStream({
              transform: parseStream,
              flush: parseStreamFlush,
              buffer: "",
            }))
            .pipeThrough(new TransformStream({
              transform: toOpenAiStream,
              flush: toOpenAiStreamFlush,
              streamIncludeUsage: req.stream_options?.include_usage,
              model: req.model || DEFAULT_MODEL,
              id: generateChatcmplId(),
              last: [],
            }))
            .pipeThrough(new TextEncoderStream());
        }
      }

      // 确保响应头包含正确的Content-Type
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Content-Type", "application/json");

      // 返回成功的响应
      return new Response(body, fixCors({
        headers: responseHeaders,
        status: response.status,
        statusText: response.statusText
      }));
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-1.5-pro-latest";
const API_CLIENT = "genai-js/0.21.0";

const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true);
}

async function parseStreamFlush (controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

const reasonsMap = {
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
};

const SEP = "\n\n|>";
const transformCandidates = (key, cand) => ({
  index: cand.index || 0,
  [key]: {
    role: "assistant",
    content: cand.content?.parts.map(p => p.text).join(SEP) },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
});

const transformCandidatesDelta = transformCandidates.bind(null, "delta");

function transformResponseStream (data, stop, first) {
  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) { item.delta.content = ""; } else { delete item.delta.role; }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\n\n";
async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) { return; }
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error(line);
    console.error(err);
    const length = this.last.length || 1;
    const candidates = Array.from({ length }, (_, index) => ({
      finishReason: "error",
      content: { parts: [{ text: err }] },
      index,
    }));
    data = { candidates };
  }
  const cand = data.candidates[0];
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  cand.index = cand.index || 0;
  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, false, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) {
    controller.enqueue(transform(data));
  }
}

async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last.length > 0) {
    for (const data of this.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});