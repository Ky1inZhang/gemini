// 测试Gemini API代理服务的连通性
import fetch from 'node-fetch';

const API_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // 替换为你的API密钥
const BASE_URL = 'https://direct-gemini.deno.dev';

async function testGeminiAPI() {
  const maxRetries = 3;
  const retryDelay = 1000; // 1秒延迟

  const fetchWithRetry = async (url, options) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(url, options);
        return response;
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        console.log(`请求失败，${i + 1}秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  };

  try {
    // 测试模型列表接口 - 使用Authorization头
    console.log('1. 测试模型列表接口 (Authorization头)...');
    const modelsResponse = await fetchWithRetry(`${BASE_URL}/v1beta/models`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('模型列表响应状态:', modelsResponse.status);
    const modelsData = await modelsResponse.text();
    try {
      const modelsJson = JSON.parse(modelsData);
      if (modelsJson.models) {
        const modelNames = modelsJson.models.map(model => model.name);
        console.log('模型名称列表:', modelNames);
      } else {
        console.log('模型列表响应内容:', modelsData);
      }
    } catch (e) {
      console.log('模型列表响应内容:', modelsData);
    }

    // 测试生成内容接口 - 使用URL参数认证
    console.log('\n2. 测试生成内容接口 (URL参数认证)...');
    const generateResponse = await fetchWithRetry(
      `${BASE_URL}/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${API_KEY}`, 
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: "你好啊 中文回答我"
            }]
          }]
        })
      }
    );

    console.log('生成内容响应状态:', generateResponse.status);
    const generateData = await generateResponse.text();
    console.log('生成内容响应内容:', generateData);

    // 测试流式生成接口
    console.log('\n3. 测试流式生成接口...');
    const streamResponse = await fetchWithRetry(
      `${BASE_URL}/v1beta/models/gemini-2.0-flash-lite:streamGenerateContent?alt=sse`, 
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: "用流式回答测试: 1+1=?"
            }]
          }]
        })
      }
    );

    console.log('流式响应状态:', streamResponse.status);
    console.log('响应头:', Object.fromEntries(streamResponse.headers.entries()));
    
    // 读取流式响应
    const reader = streamResponse.body;
    let buffer = '';
    
    reader.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      
      // 处理完整的行
      while (lines.length > 1) {
        const line = lines.shift().trim();
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('流式传输完成');
          } else {
            try {
              const jsonData = JSON.parse(data);
              console.log('收到流式数据:', JSON.stringify(jsonData, null, 2));
            } catch (e) {
              console.log('收到非JSON数据:', data);
            }
          }
        }
      }
      
      // 保存未处理完的数据
      buffer = lines.join('\n');
    });
    
    reader.on('end', () => {
      console.log('流式响应结束');
      // 处理剩余的buffer
      if (buffer.trim()) {
        console.log('剩余数据:', buffer);
      }
    });

    // 等待流式响应完成
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 测试NextChat场景
    console.log('\n4. 测试NextChat场景...');
    const nextChatResponse = await fetchWithRetry(
      `${BASE_URL}/v1beta/models/gemini-1.5-flash-latest:streamGenerateContent?alt=sse`, 
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'x-goog-api-key': API_KEY
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{
              text: "测试NextChat场景"
            }]
          }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 4000,
            topP: 1
          },
          safetySettings: [
            {category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH"},
            {category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH"},
            {category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH"},
            {category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH"}
          ]
        })
      }
    );

    console.log('NextChat响应状态:', nextChatResponse.status);
    console.log('响应头:', Object.fromEntries(nextChatResponse.headers.entries()));
    
    // 读取流式响应
    const nextChatReader = nextChatResponse.body;
    let nextChatBuffer = '';
    
    nextChatReader.on('data', chunk => {
      nextChatBuffer += chunk.toString();
      const lines = nextChatBuffer.split('\n');
      
      while (lines.length > 1) {
        const line = lines.shift().trim();
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('NextChat流式传输完成');
          } else {
            try {
              const jsonData = JSON.parse(data);
              console.log('收到NextChat数据:', JSON.stringify(jsonData, null, 2));
            } catch (e) {
              console.log('收到非JSON数据:', data);
            }
          }
        }
      }
      
      nextChatBuffer = lines.join('\n');
    });
    
    nextChatReader.on('end', () => {
      console.log('NextChat响应结束');
      if (nextChatBuffer.trim()) {
        console.log('剩余数据:', nextChatBuffer);
      }
    });

    // 等待NextChat响应完成
    await new Promise(resolve => setTimeout(resolve, 5000));

  } catch (error) {
    console.error('请求过程中发生错误:', error);
  }
}

testGeminiAPI();