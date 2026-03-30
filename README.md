# Aurelia FMS — React/Vite

A Fooda Management Suite. Enterprise food service operations platform.

## Stack
- **Frontend**: React 18 + Vite (code-split by route)
- **Auth**: AWS Cognito (USER_PASSWORD_AUTH flow)
- **Database**: Firebase Firestore
- **API**: Netlify Functions (JWT-protected)
- **Hosting**: Netlify

## Local Development

```bash
# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env.local

# Start dev server
npm run dev
```

## Build & Deploy

```bash
# Build for production
npm run build

# Preview production build locally
npm run preview
```

Netlify deploys automatically from the `main` branch.

## Project Structure

```
src/
├── routes/           # Page components (lazy-loaded, code-split)
│   ├── auth/         # Login, SignUp, ForgotPassword
│   ├── Dashboard.jsx
│   ├── Inventory.jsx
│   ├── OrderHub.jsx
│   └── ...
├── components/
│   ├── layout/       # AppShell (topbar + sidebar)
│   └── ui/           # Shared UI components
├── lib/
│   ├── auth.js       # Cognito auth helpers
│   └── firebase.js   # Firestore helpers
├── store/
│   └── authStore.js  # Zustand auth state
└── App.jsx           # Router + route guards
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase project API key |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_COGNITO_REGION` | AWS region (us-east-2) |
| `VITE_COGNITO_CLIENT_ID` | Cognito app client ID |

Set these in Netlify → Environment variables for production.
Set in `.env.local` for local development.

## Auth Flow

1. User signs in via Cognito `USER_PASSWORD_AUTH`
2. ID token stored in `sessionStorage`
3. ID token sent as `Authorization: Bearer <token>` to all Netlify functions
4. Functions validate token via Cognito JWKS
5. `custom:role` and `custom:tenantId` claims control access

## Roles

| Role | Access |
|------|--------|
| `admin` | Full access, user management |
| `director` | Full access to assigned locations |
| `areaManager` | Read/write for assigned locations |
| `viewer` | Read-only |
