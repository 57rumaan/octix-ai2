# AETHER AI — Multi-Model AI Web App

Ek chat web app jo multiple AI models ko route karta hai, plus ek alag,
password-protected admin panel jahan se models add/enable/disable aur
rules set kiye jaate hain.

## Folder structure
```
ai-web-app/
  frontend/            → chat UI (index.html) — end users ye dekhte hain
  backend/
    server.js           → main server, saare routes yahan wire hote hain
    .env.example        → copy karke .env banayein; saari env vars yahin list hain
    lib/                → shared helpers (async error handling, rate limiting, env checks)
    routes/
      auth.js            → user signup/login (email verification via Resend)
      chat.js            → message ko enabled model tak route karta hai (login required)
      admin.js           → admin login + protected admin APIs
    admin/index.html     → admin dashboard UI — /admin par serve hota hai
    config/store.js      → provider/model settings + users JSONBin.io par store hote hain
    config/models.json   → purana sample file (ab kahin se bhi load nahi hoti)
  Dockerfile            → container image (backend + frontend dono)
```

## Local setup (free)
1. Node.js install karein (nodejs.org se, free)
2. Terminal mein:
   ```
   cd backend
   npm install
   cp .env.example .env
   ```
3. `.env` file open karke fill karein — **4 cheezein required hain** (server inke bina start nahi hota, aur missing variable ka naam clearly print karta hai):
   - `JWT_SECRET` — command diya hua hai .env.example mein, chalayein aur paste karein
   - `ADMIN_PASSWORD_HASH` — apna admin password socho, phir wahi command chalayein
     jo bcrypt hash deti hai, aur wo hash yahan paste karein (plaintext password
     kahin bhi file mein nahi jaata — ye important hai warna app decompile
     karke koi bhi password nikal sakta hai)
   - `JSONBIN_BIN_ID` + `JSONBIN_API_KEY` — jsonbin.io par free bin banao aur
     yahan daalo (provider settings + user accounts permanent yahin store hote hain)
4. Optional variables (jin feature ko chahiye wahi bharein):
   - `RESEND_API_KEY` — signup verification email ke liye (na ho to signup clearly error deta hai)
   - `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `HUGGINGFACE_API_KEY` —
     jab aap API buy karo tab yahan daalna
5. Run: `npm start`
6. Chat app: http://localhost:3000
   Admin panel: http://localhost:3000/admin
   Health check: http://localhost:3000/api/health

> Chat bhejne ke liye login zaroori hai (email + password). Bina login ke
> `/api/chat` 401 return karta hai; har IP per basic rate limits bhi lagti hain.


## Admin panel kaise kaam karta hai (secure version)
- Chat UI mein kahin bhi koi hidden trigger phrase nahi hai — wo approach
  insecure hoti hai kyunki app ka code inspect karke koi bhi wo trigger
  aur password nikal sakta hai.
- Iske bajaye admin panel ek bilkul alag URL (`/admin`) par hai, jo chat
  app se link nahi hota. Wahan real login form hai.
- Password kabhi bhi plaintext store nahi hota — sirf uska bcrypt hash
  `.env` mein hota hai, server par.
- Login successful hone par ek time-limited session token (JWT) milta hai,
  jo har admin action ko verify karta hai.

## Models/APIs add karna
`/admin` → "Add APIs" tab:
- Sirf unhi providers ko add kar sakte hain jinke liye backend mein adapter
  already hai: **OpenAI, Google Gemini, Groq, Hugging Face**
  (`backend/lib/providers.js` — isi list se admin panel provider options
  dikhata hai, aur server naye unsupported provider ko save karne se rok deta hai)
- Har provider ka block dikhta hai, jisme uski API key `.env` se aati hai
  (env variable ka naam dikhta hai, key khud kabhi screen par nahi aati)
- "Models" tab mein group/bundle banakar chat + image models ko ek naam ke
  neeche joda jaata hai; wahi group chat app ke model picker mein dikhta hai
- Naya provider type (jaise Anthropic/Mistral) jodne ke liye: `backend/lib/providers.js`
  ki list mein id add karein, aur `backend/routes/chat.js` ke `callProvider()`
  mein us provider ke liye ek naya `if` block likhein (jaisa OpenAI/Gemini/
  Groq ke liye already hai)

## Abhi kya kaam karta hai / kya baaki hai
- Chat: login required hai; global rules + per-model rules dono lagte hain
  (OpenAI, Gemini, Groq, Hugging Face par) — aur har IP per basic rate limits
- Image generation: group mein image model ho to wahi use hota hai, warna
  free fallback generator (frontend ke existing fallback se)
- Voice output: browser ki apni speech synthesis (group ka "Voice replies"
  toggle); voice input: browser speech recognition (Chrome/Edge)
- Video generation: abhi placeholder modal hai (paid key chahiye hogi)
- Files (docs/PDF): UI mein chip dikhta hai, par abhi backend tak nahi
  pahunchta — sirf images backend ko bheji ja sakti hain
- User accounts: JSONBin mein permanent store hote hain (bcrypt hashed
  passwords); admin config save kabhi `users` array ko overwrite nahi karta
- Google/Facebook login: OAuth abhi stub hai (501) — Firebase Authentication
  sabse fast free tarika hai in dono ko ek saath enable karne ka

## Free/cheap hosting (jab live karna ho)
- **Render.com** ya **Railway.app** — Node backend free tier
- Docker image repo ke root `Dockerfile` se banti hai (backend + frontend
  dono andar hote hain): `docker build -t aether-ai .` aur phir
  `docker run -p 3000:3000 --env-file backend/.env aether-ai`
  (image `/api/health` par health check karti hai)
- **Firebase Hosting** — frontend ke liye free
- Domain optional hai; free subdomain (jaise `yourapp.onrender.com`) se
  bhi shuru kar sakte hain
- Deploy karte waqt upar wali saari env vars Render/Railway ke "Environment"
  section mein daalein (file wahan nahi jaati)

## Android app baad mein
Jab APK banani ho, ye web app already ready hoga — WebView wrapper
(Android Studio) mein isi URL ko load karke ek basic APK ban jaata hai,
ya baad mein proper native app (Kotlin) bhi bana sakte hain jo isi
backend ko use kare.
