import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5-mini';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst';

const DATA_FILE = path.resolve(process.env.QUOTA_FILE || './quota.json');
const MAX_BODY = 18 * 1024 * 1024;

const SYSTEM_PROMPT = `
تو دستیار هوشمند اپلیکیشن TahaArt هستی.
به فارسی روان و مفید پاسخ بده.
در زمینه طراحی گرافیک، پوستر فوتبالی، پرامپت‌نویسی،
فتوشاپ، ایبیس پینت، ریتاچ، نورپردازی و طراحی حرفه‌ای تخصص داشته باش.
اگر کاربر زبان دیگری خواست، همان زبان را استفاده کن.
پاسخ‌هایت دقیق، کاربردی و قابل فهم باشند.
هرگز ادعا نکن کاری را انجام داده‌ای مگر واقعاً انجام شده باشد.
`;

let quota = {};

try {
  quota = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
} catch {
  quota = {};
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function safeId(value) {
  return String(value || 'guest')
    .slice(0, 160)
    .replace(/[^\w.@:-]/g, '_') || 'guest';
}

async function bodyJson(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > MAX_BODY) {
      throw Object.assign(
        new Error('حجم درخواست بیش از حد مجاز است. عکس کوچک‌تری انتخاب کن.'),
        { status: 413 }
      );
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(
      new Error('درخواست JSON معتبر نیست.'),
      { status: 400 }
    );
  }
}

async function callOpenAI(url, payload) {
  if (!API_KEY) {
    throw Object.assign(
      new Error('کلید OPENAI_API_KEY روی سرور تنظیم نشده است.'),
      { status: 503 }
    );
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `خطای سرویس هوش مصنوعی (${response.status})`;

    throw Object.assign(new Error(message), {
      status: response.status >= 500 ? 502 : response.status,
      upstreamStatus: response.status
    });
  }

  return data;
}

async function saveQuota() {
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(quota, null, 2),
    'utf8'
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // بررسی وضعیت سرور
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'TahaArt AI',
      chatModel: CHAT_MODEL,
      imageModel: IMAGE_MODEL,
      apiKeyConfigured: Boolean(API_KEY)
    });
  }

  try {
    // بررسی سهمیه روزانه تولید تصویر
    if (req.method === 'POST' && url.pathname === '/quota') {
      const body = await bodyJson(req);
      const userId = safeId(body.user_id);
      const day = todayUTC();

      const key = crypto
        .createHash('sha256')
        .update(`${day}:${userId}`)
        .digest('hex');

      const record = quota[key] || { day, count: 0 };
      const used = record.day === day ? record.count || 0 : 0;

      return json(res, 200, {
        day,
        used,
        remaining: Math.max(0, 3 - used),
        limit: 3
      });
    }

    // گفت‌وگو با هوش مصنوعی
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await bodyJson(req);

      const history = Array.isArray(body.history)
        ? body.history.slice(-12)
        : [];

      const input = [];

      for (const message of history) {
        if (
          !message ||
          !['user', 'assistant'].includes(message.role)
        ) {
          continue;
        }

        const messageText = String(
          message.content ?? message.text ?? ''
        ).slice(0, 12000);

        if (message.role === 'assistant') {
          input.push({
            role: 'assistant',
            content: messageText
          });

          continue;
        }

        const content = [
          {
            type: 'input_text',
            text: messageText
          }
        ];

        if (
          body.image_data &&
          message === history[history.length - 1]
        ) {
          if (
            !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(
              body.image_data
            )
          ) {
            throw Object.assign(
              new Error('فرمت عکس پشتیبانی نمی‌شود. PNG، JPG یا WEBP بفرست.'),
              { status: 400 }
            );
          }

          content.push({
            type: 'input_image',
            image_url: body.image_data,
            detail: 'high'
          });
        }

        input.push({
          role: 'user',
          content
        });
      }

      if (!input.length) {
        const content = [
          {
            type: 'input_text',
            text: String(body.message || '').slice(0, 12000)
          }
        ];

        if (body.image_data) {
          content.push({
            type: 'input_image',
            image_url: body.image_data,
            detail: 'high'
          });
        }

        input.push({
          role: 'user',
          content
        });
      } else if (
        body.image_data &&
        input[input.length - 1].role !== 'user'
      ) {
        input.push({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: String(body.message || 'این عکس را بررسی کن.')
            },
            {
              type: 'input_image',
              image_url: body.image_data,
              detail: 'high'
            }
          ]
        });
      }

      const result = await callOpenAI(
        'https://api.openai.com/v1/responses',
        {
          model: CHAT_MODEL,
          instructions: SYSTEM_PROMPT,
          input,
          max_output_tokens: 1200
        }
      );

      const reply =
        result.output_text ||
        (result.output || [])
          .flatMap(item => item.content || [])
          .filter(item => item.type === 'output_text')
          .map(item => item.text)
          .join('\n');

      if (!reply) {
        throw Object.assign(
          new Error('پاسخ متنی از سرویس دریافت نشد.'),
          { status: 502 }
        );
      }

      return json(res, 200, {
        reply,
        response_id: result.id
      });
    }

    // تولید تصویر با هوش مصنوعی
    if (
      req.method === 'POST' &&
      url.pathname === '/generate-image'
    ) {
      const body = await bodyJson(req);
      const prompt = String(body.prompt || '').trim();

      if (!prompt) {
        return json(res, 400, {
          error: 'توضیح تصویر را بنویس.'
        });
      }

      if (prompt.length > 10000) {
        return json(res, 400, {
          error: 'توضیح تصویر خیلی طولانی است. کوتاه‌ترش کن.'
        });
      }

      const userId = safeId(body.user_id);
      const day = todayUTC();

      const key = crypto
        .createHash('sha256')
        .update(`${day}:${userId}`)
        .digest('hex');

      const record = quota[key] || { day, count: 0 };

      if (record.day !== day) {
        record.day = day;
        record.count = 0;
      }

      if (record.count >= 3) {
        return json(res, 429, {
          error: 'سهمیه روزانه تولید تصویر تمام شده است.',
          remaining: 0
        });
      }

      const result = await callOpenAI(
        'https://api.openai.com/v1/images/generations',
        {
          model: IMAGE_MODEL,
          prompt,
          size: '1024x1536',
          quality: 'high',
          output_format: 'png',
          n: 1
        }
      );

      const generatedImage = result.data?.[0]?.b64_json;

      if (!generatedImage) {
        throw Object.assign(
          new Error('سرویس تصویر خروجی PNG برنگرداند.'),
          { status: 502 }
        );
      }

      record.count += 1;
      quota[key] = record;

      await saveQuota();

      return json(res, 200, {
        image_base64: generatedImage,
        remaining: Math.max(0, 3 - record.count),
        model: IMAGE_MODEL
      });
    }

    return json(res, 404, {
      error: 'مسیر پیدا نشد. از /health، /chat یا /generate-image استفاده کن.'
    });

  } catch (error) {
    console.error('[TahaArt AI]', error?.stack || error);

    const status = error.status || 500;
    let message = error.message || 'خطای ناشناخته در سرور.';

    if (error.upstreamStatus === 401) {
      message = 'کلید API نامعتبر است. کلید سرور را بررسی کن.';
    } else if (error.upstreamStatus === 429) {
      message = 'محدودیت درخواست یا اعتبار API تمام شده است.';
    } else if (error.upstreamStatus === 403) {
      message = 'دسترسی به مدل انتخاب‌شده مجاز نیست.';
    }

    return json(res, status, {
      error: message
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `TahaArt AI server listening on port ${PORT}; key configured: ${Boolean(API_KEY)}`
  );
});
