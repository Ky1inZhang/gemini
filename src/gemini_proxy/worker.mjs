import { Buffer } from "node:buffer";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    const errHandler = async (err) => {
      console.error('Error details:', err);
      if (err instanceof Response) {
        const responseHeaders = new Headers(err.headers);
        responseHeaders.set("Content-Type", "application/json");
        return new Response(err.body, fixCors({
          headers: responseHeaders,
          status: err.status,
          statusText: err.statusText
        }));
      }
      return new Response(JSON.stringify({
        error: {
          code: err.status || 500,
          message: err.message || "Internal server error",
          status: "INTERNAL"
        }
      }), fixCors({
        status: err.status || 500,
        headers: {
          "Content-Type": "application/json"
        }
      }));
    };

    try {
      const url = new URL(request.url);
      
      // 支持多种方式获取API key
      let apiKey = url.searchParams.get("key") || 
                  request.headers.get("x-goog-api-key") || 
                  (request.headers.get("Authorization")?.split(" ")[1]);
      
      if (!apiKey) {
        throw new HttpError("Missing API key", 401);
      }

      // 处理POST请求体
      let requestBody;
      if (request.method === "POST") {
        const bodyText = await request.text();
        try {
          requestBody = JSON.parse(bodyText);
          
          // 确保contents存在且为数组
          if (!requestBody.contents || !Array.isArray(requestBody.contents)) {
            throw new HttpError("Invalid request body: missing or invalid contents array", 400);
          }

          // 确保每个content都有有效的parts
          requestBody.contents = requestBody.contents.map(content => {
            if (!content.parts || !Array.isArray(content.parts)) {
              content.parts = [{ text: content.text || "" }];
            }
            return content;
          });

          // 移除空的content
          requestBody.contents = requestBody.contents.filter(content => 
            content.parts.some(part => part.text && part.text.trim() !== "")
          );

          if (requestBody.contents.length === 0) {
            throw new HttpError("Invalid request body: no valid content found", 400);
          }
        } catch (e) {
          console.error('Request body parsing error:', e);
          throw new HttpError("Invalid request body: " + e.message, 400);
        }
      }

      // 移除key参数，避免重复
      const cleanUrl = new URL(url.toString());
      cleanUrl.searchParams.delete("key");
      
      // 修正路径中的双斜杠
      let pathname = cleanUrl.pathname.replace(/\/+/g, '/');
      
      // 构建目标URL
      const targetUrl = `https://generativelanguage.googleapis.com${pathname}${cleanUrl.search}`;
      
      // 构建请求头
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("x-goog-api-key", apiKey);

      // 复制必要的请求头
      const headersToKeep = [
        "Accept",
        "x-goog-api-client",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform"
      ];

      for (const header of headersToKeep) {
        const value = request.headers.get(header);
        if (value) {
          headers.set(header, value);
        }
      }

      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: requestBody ? JSON.stringify(requestBody) : undefined
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('Gemini API error:', errorBody);
        return new Response(errorBody, fixCors({
          status: response.status,
          headers: {
            "Content-Type": "application/json"
          }
        }));
      }

      const responseHeaders = new Headers();
      
      // 处理SSE响应
      if (url.searchParams.has("alt") && url.searchParams.get("alt") === "sse") {
        responseHeaders.set("Content-Type", "text/event-stream");
        responseHeaders.set("Cache-Control", "no-cache");
        responseHeaders.set("Connection", "keep-alive");
      } else {
        responseHeaders.set("Content-Type", "application/json");
      }

      return new Response(response.body, fixCors({
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
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Max-Age", "86400");
  return { headers, status, statusText };
};

const handleOPTIONS = () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    }
  });
};

const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": "genai-js/0.21.0",
  "x-goog-api-key": apiKey,
  ...more
});

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const API_CLIENT = "genai-js/0.21.0";

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
    const length = this.last.length || 1;
    const candidates = Array.from({ length }, (_, index) => ({
      finishReason: "error",
      content: { parts: [{ text: err }] },
      index,
    }));
    data = { candidates };
  }
  const cand = data.candidates[0];
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