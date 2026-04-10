# Aurelia FMS — SSO Setup Guide

**For:** Fooda IT team
**From:** Troy Robinson
**Date:** April 2026

---

## What this is

Aurelia FMS supports Single Sign-On (SSO) via SAML 2.0 or OIDC. This guide provides the information your IT team needs to create an app registration in your identity provider (Okta, Azure AD, Google Workspace, or any SAML/OIDC-compliant IdP).

---

## Option A: SAML 2.0

### Service Provider details (enter these in your IdP)

| Field | Value |
|---|---|
| ACS URL (Assertion Consumer Service) | `https://aureliafms.com/auth/saml/callback` |
| Entity ID / Audience | `aurelia-fms-fooda` |
| Name ID format | `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` |
| Name ID value | User's email address |
| Sign-on URL | `https://aureliafms.com/login` |

### Attribute mapping (required)

| SAML Attribute | Maps to |
|---|---|
| `email` | User's email address |
| `displayName` or `name` | User's full name |

### What we need back from you

1. **IdP SSO URL** — the endpoint Aurelia redirects users to for authentication
2. **IdP Certificate** — the X.509 certificate in PEM format used to verify SAML assertions

Enter these in Aurelia at **Settings → SSO → SAML configuration**.

---

## Option B: OIDC (OpenID Connect)

### Application registration details

| Field | Value |
|---|---|
| Redirect URI / Callback URL | `https://aureliafms.com/auth/oidc/callback` |
| Sign-out redirect | `https://aureliafms.com/login` |
| Application type | Web application |
| Grant type | Authorization Code |

### Scopes required

`openid`, `email`, `profile`

### What we need back from you

1. **Issuer URL** — usually `https://your-idp.com/.well-known/openid-configuration`
2. **Client ID** — the application/client ID from your IdP
3. **Client Secret** — the application secret (stored encrypted in Aurelia)

Enter these in Aurelia at **Settings → SSO → OIDC configuration**.

---

## Timeline

Once we receive the IdP credentials above, SSO activation takes approximately 1-2 business days for integration and testing. During that period, users continue logging in with username/password. After SSO is activated, admins can optionally enforce SSO-only login and require MFA via the Settings → SSO → Access policies panel.

---

## Questions?

Contact Troy Robinson — troy.robinson@fooda.com
