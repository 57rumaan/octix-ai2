# AETHER AI — Multi-Model AI Web App

Ek chat web app jo multiple AI models ko route karta hai, plus ek alag,
password-protected admin panel jahan se models add/enable/disable aur
rules set kiye jaate hain.

## Folder structure
```
ai-web-app/
  frontend/          → chat UI (index.html) — end users ye dekhte hain
  backend/
    server.js         → main server, saare routes yahan wire hote hain
    routes/
      auth.js          → user signup/login (email/phone; Google/FB stub)
      chat.js          → message ko enabled model tak route karta hai
      admin.js          → admin login + protected admin APIs
    admin/index.html    → admin dashboard UI — /admin par serve hota hai
    config/models.json  → kaunse providers/models added hain, kaun enabled hai
    .env.example         → yahan API keys aur secrets jaate hain
```

## Local setup (free)
1. Node.js install karein (nodejs.org se, free)
2. Terminal mein:
   ```
   cd backend
   npm install
   cp .env.example .env
   ```
3. `.env` file open karke fill karein:
   - `JWT_SECRET` — command diya hua hai .env.example mein, chalayein aur paste karein
   - `ADMIN_PASSWORD_HASH` — apna admin password socho, phir wahi command chalayein
     jo bcrypt hash deti hai, aur wo hash yahan paste karein (plaintext password
     kahin bhi file mein nahi jaata — ye important hai warna app decompile
     karke koi bhi password nikaal sakta hai)
   - `OPENAI_API_KEY` / `GEMINI_API_KEY` — jab aap API buy karo tab yahan daalna
4. Run: `npm start`
5. Chat app: http://localhost:3000
   Admin panel: http://localhost:3000/admin

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
`/admin` → "Add / manage APIs" tab:
- Har provider (OpenAI, Gemini, etc.) ka ek block hai, jisme uski API key
  `.env` se aati hai (env variable ka naam dikhta hai, key khud kabhi
  screen par nahi aati)
- Har model ko custom naam de sakte hain, enable/disable toggle hai
- Naya provider add karne ke liye: `backend/config/models.json` mein ek
  naya block add karein, aur `backend/routes/chat.js` ke `callProvider()`
  function mein us provider ke liye ek naya `if` block likhein jo uski
  API ko call kare (jaisa OpenAI/Gemini ke liye already hai)

## Baaki features jo abhi UI mein hain, backend wiring baaki hai
- Image/video generation, text-to-voice, voice-to-text: composer ke
  "+" menu mein options already hain — inhe kaam karne ke liye jo bhi
  provider aap choose karein (jaise ElevenLabs for voice, Runway/Stability
  for image-video), uske liye bhi `callProvider()` jaisa ek function
  `chat.js` mein add hoga
- Real user database: abhi `auth.js` mein users memory mein store hote
  hain (server restart pe delete ho jaate hain) — Firebase Auth ya
  Supabase (dono free tier dete hain) laga kar isko permanent banayein
- Google/Facebook login: Firebase Authentication sabse fast free tarika
  hai in dono ko ek saath enable karne ka

## Free/cheap hosting (jab live karna ho)
- **Render.com** ya **Railway.app** — Node backend free tier
- **Firebase Hosting** — frontend ke liye free
- Domain optional hai; free subdomain (jaise `yourapp.onrender.com`) se
  bhi shuru kar sakte hain

## Android app baad mein
Jab APK banani ho, ye web app already ready hoga — WebView wrapper
(Android Studio) mein isi URL ko load karke ek basic APK ban jaata hai,
ya baad mein proper native app (Kotlin) bhi bana sakte hain jo isi
backend ko use kare.
