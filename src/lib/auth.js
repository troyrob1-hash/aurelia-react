import { signInWithCognito, signOutFirebase } from './firebase'

const REGION    = import.meta.env.VITE_COGNITO_REGION    || 'us-east-2'
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || '29lq06sva9bvh2rns29s2vjcc2'
const ENDPOINT  = `https://cognito-idp.${REGION}.amazonaws.com/`

async function cognitoPost(action, body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || data.__type || 'Auth error')
  return data
}

const SESSION_KEY = 'aurelia_session'

export function saveSession(authResult) {
  const session = {
    accessToken:  authResult.AccessToken,
    idToken:      authResult.IdToken,
    refreshToken: authResult.RefreshToken,
    expiresAt:    Date.now() + (authResult.ExpiresIn || 3600) * 1000,
  }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return session
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY)
}

export function getAuthHeaders() {
  const session = loadSession()
  if (!session?.idToken) return {}
  return { Authorization: `Bearer ${session.idToken}` }
}

export async function signIn(email, password) {
  const data = await cognitoPost('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })

  if (data.AuthenticationResult) {
    const session = saveSession(data.AuthenticationResult)
    await signInWithCognito(data.AuthenticationResult.IdToken)
    return { type: 'success', session }
  }
  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { type: 'new_password', session: data.Session }
  }
  throw new Error('Authentication failed')
}

export async function completeNewPassword(email, newPassword, session) {
  const data = await cognitoPost('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: CLIENT_ID,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    Session: session,
  })
  if (data.AuthenticationResult) {
    const newSession = saveSession(data.AuthenticationResult)
    await signInWithCognito(data.AuthenticationResult.IdToken)
    return newSession
  }
  throw new Error('Password change failed')
}

export async function getUser(accessToken) {
  const data = await cognitoPost('GetUser', { AccessToken: accessToken })
  const attrs = {}
  ;(data.UserAttributes || []).forEach(a => { attrs[a.Name] = a.Value })
  return attrs
}

export async function refreshSession(refreshToken) {
  const data = await cognitoPost('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  })
  if (data.AuthenticationResult) {
    const session = saveSession({ ...data.AuthenticationResult, RefreshToken: refreshToken })
    await signInWithCognito(data.AuthenticationResult.IdToken)
    return session
  }
  throw new Error('Session refresh failed')
}

export async function signOut() {
  clearSession()
  await signOutFirebase()
}

export async function signUp(email, password, name) {
  return cognitoPost('SignUp', {
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name',  Value: name  },
      { Name: 'custom:role',     Value: 'viewer' },
      { Name: 'custom:tenantId', Value: 'fooda'  },
    ],
  })
}

export async function confirmSignUp(email, code) {
  return cognitoPost('ConfirmSignUp', {
    ClientId: CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  })
}

export async function forgotPassword(email) {
  return cognitoPost('ForgotPassword', { ClientId: CLIENT_ID, Username: email })
}

export async function confirmForgotPassword(email, code, newPassword) {
  return cognitoPost('ConfirmForgotPassword', {
    ClientId: CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
    Password: newPassword,
  })
}