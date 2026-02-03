# WhatsApp Vercel Server

A WhatsApp server using Baileys library - compatible with Vercel serverless functions.

## ⚡ Vercel Deployment

### Quick Deploy

1. Fork/clone this repository
2. Import to Vercel: https://vercel.com/new
3. Set environment variable:
   - `FRONTEND_URL`: Your frontend URL (e.g., `https://your-app.lovable.app`)
4. Deploy!

### Important Notes for Vercel

⚠️ **Serverless Limitations:**
- Sessions are stored in `/tmp` which is ephemeral
- Each function invocation may use a different instance
- Long-running connections may timeout after 60 seconds
- For production use, consider adding Vercel KV for session persistence

### Better Session Persistence (Optional)

For persistent sessions across deployments, add Vercel KV:

1. Add Vercel KV to your project
2. The server will automatically use KV for session storage

## 🖥️ Local Development

```bash
cd whatsapp-server
npm install
npm run dev
```

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/connection-status` | Get current connection state |
| POST | `/api/request-pairing-code` | Request a pairing code |
| GET | `/api/chats` | Get all chats |
| GET | `/api/chats/:chatId/messages` | Get messages for a chat |
| POST | `/api/chats/:chatId/messages` | Send a message |
| GET | `/api/contacts` | Get contacts |
| POST | `/api/disconnect` | Disconnect session |

## 🔑 Pairing Code Flow

1. Frontend sends phone number to `/api/request-pairing-code`
2. Server initializes Baileys client and generates pairing code
3. User enters the 8-digit code in WhatsApp mobile app:
   - Settings → Linked Devices → Link a Device → Link with phone number
4. Frontend polls `/api/connection-status` until connected
5. Once connected, all chat APIs become available

## 📝 Request Examples

### Request Pairing Code
```bash
curl -X POST https://your-app.vercel.app/api/request-pairing-code \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "12345678900"}'
```

### Send Message
```bash
curl -X POST https://your-app.vercel.app/api/chats/1234567890@s.whatsapp.net/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from the API!"}'
```

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port (local only) | 3001 |
| `FRONTEND_URL` | CORS allowed origin | * |
| `VERCEL` | Auto-set by Vercel | - |

## 🆚 Baileys vs whatsapp-web.js

This server uses **Baileys** instead of whatsapp-web.js because:

| Feature | Baileys | whatsapp-web.js |
|---------|---------|-----------------|
| Puppeteer Required | ❌ No | ✅ Yes |
| Vercel Compatible | ✅ Yes | ❌ No |
| Memory Usage | Low | High |
| Browser Dependencies | None | Many |

## ⚠️ Known Limitations

1. **Ephemeral Storage**: On Vercel, `/tmp` is cleared between invocations
2. **Cold Starts**: First request after idle may take longer
3. **Timeout**: Max 60 seconds per request on Vercel Pro
4. **Stateless**: Each request may hit a different instance

## 🚀 Production Recommendations

For production use with persistent connections:

1. **Vercel + KV**: Add Vercel KV for session storage
2. **Railway/Render**: Use a persistent server platform
3. **VPS**: Self-host on DigitalOcean, AWS, etc.

## 📄 License

MIT
