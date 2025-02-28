export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      const { pathname } = new URL(request.url);
      
      // 直接转发请求到Gemini API
      const targetUrl = `https://generativelanguage.googleapis.com${pathname}`;
      const headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      };

      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "POST" ? await request.text() : undefined
      });

      // 直接返回Gemini的响应
      return new Response(response.body, fixCors(response));
    } catch (err) {
      return errHandler(err);
    }
  }
};

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