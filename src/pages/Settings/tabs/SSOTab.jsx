// src/pages/Settings/tabs/SSOTab.jsx
import { useState, useEffect } from "react";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db }      from "@/lib/firebase";
import { useAuth } from "@/hooks/useAuth";
import Spinner     from "@/components/ui/Spinner";

const PROVIDERS = [
  { value: "okta",   label: "Okta",            logo: "O" },
  { value: "azure",  label: "Azure AD",         logo: "A" },
  { value: "google", label: "Google Workspace", logo: "G" },
  { value: "custom", label: "Custom SAML/OIDC", logo: "C" },
];

export default function SSOTab() {
  const { orgId, user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState(null);
  const [success,  setSuccess]  = useState(false);

  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [provider,   setProvider]   = useState("okta");
  const [protocol,   setProtocol]   = useState("saml");
  const [samlConfig, setSamlConfig] = useState({ entryPoint: "", certificate: "" });
  const [oidcConfig, setOidcConfig] = useState({ clientId: "", clientSecret: "", issuerUrl: "" });
  const [ssoOnly,    setSsoOnly]    = useState(false);
  const [requireMFA, setRequireMFA] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDoc(doc(db, "orgs", orgId));
        if (snap.exists()) {
          const d = snap.data();
          setSsoEnabled(d.ssoEnabled ?? false);
          setProvider(d.ssoProvider ?? "okta");
          setSsoOnly(d.settings?.ssoOnly ?? false);
          setRequireMFA(d.settings?.requireMFA ?? false);
          if (d.ssoConfig) {
            if (d.ssoConfig.entryPoint) {
              setProtocol("saml");
              setSamlConfig({ entryPoint: d.ssoConfig.entryPoint ?? "", certificate: d.ssoConfig.certificate ?? "" });
              setIsConnected(!!(d.ssoConfig.entryPoint && d.ssoConfig.certificate));
            } else if (d.ssoConfig.clientId) {
              setProtocol("oidc");
              setOidcConfig({ clientId: d.ssoConfig.clientId ?? "", clientSecret: "", issuerUrl: d.ssoConfig.issuerUrl ?? "" });
              setIsConnected(!!(d.ssoConfig.clientId && d.ssoConfig.issuerUrl));
            }
          }
        }
      } catch (e) {
        setError("Failed to load SSO settings.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [orgId]);

  const setSaml = f => e => setSamlConfig(p => ({ ...p, [f]: e.target.value }));
  const setOidc = f => e => setOidcConfig(p => ({ ...p, [f]: e.target.value }));

  const validate = () => {
    if (!ssoEnabled) return null;
    if (protocol === "saml") {
      if (!samlConfig.entryPoint.trim())  return "IdP SSO URL is required.";
      if (!samlConfig.certificate.trim()) return "IdP certificate is required.";
    } else {
      if (!oidcConfig.clientId.trim())  return "Client ID is required.";
      if (!oidcConfig.issuerUrl.trim()) return "Issuer URL is required.";
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true); setError(null); setSuccess(false);
    try {
      const ssoConfig = ssoEnabled
        ? protocol === "saml"
          ? { entryPoint: samlConfig.entryPoint.trim(), certificate: samlConfig.certificate.trim(), clientId: null }
          : { entryPoint: null, certificate: null, clientId: oidcConfig.clientId.trim(), issuerUrl: oidcConfig.issuerUrl.trim() }
        : null;
      await updateDoc(doc(db, "orgs", orgId), {
        ssoEnabled, ssoProvider: ssoEnabled ? provider : null, ssoConfig,
        "settings.ssoOnly": ssoOnly, "settings.requireMFA": requireMFA,
        updatedAt: serverTimestamp(),
      });
      if (ssoEnabled) {
        if (protocol === "saml") setIsConnected(!!(samlConfig.entryPoint.trim() && samlConfig.certificate.trim()));
        else setIsConnected(!!(oidcConfig.clientId.trim() && oidcConfig.issuerUrl.trim()));
      } else {
        setIsConnected(false);
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e.message ?? "Failed to save SSO settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleCopySP = (text) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) return <Spinner />;

  return (
    <div className="tab-content" style={{ maxWidth: 640 }}>
      {/* Connection status banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px", borderRadius: 8, marginBottom: "1rem",
        fontSize: 13,
        background: ssoEnabled && isConnected ? "#EAF3DE" : ssoEnabled ? "#FEF3CD" : "var(--color-background-secondary)",
        color: ssoEnabled && isConnected ? "#3B6D11" : ssoEnabled ? "#856404" : "var(--color-text-secondary)",
        border: `0.5px solid ${ssoEnabled && isConnected ? "#C0DD97" : ssoEnabled ? "#FFEEBA" : "var(--color-border-tertiary)"}`,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: ssoEnabled && isConnected ? "#3B6D11" : ssoEnabled ? "#856404" : "var(--color-text-tertiary)",
        }} />
        {ssoEnabled && isConnected
          ? "Connected — SSO is configured and ready. Complete the IdP app registration to activate."
          : ssoEnabled
            ? "Awaiting configuration — enter your IdP credentials below, then coordinate with IT to complete the app registration."
            : "SSO is disabled. Enable it to allow users to log in with your identity provider."}
      </div>

      {/* SSO toggle */}
      <div className="sso-card">
        <div className="sso-card-head">
          <div>
            <div style={{ fontWeight: 500, fontSize: 14 }}>Single sign-on (SSO)</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>Allow users to log in with your identity provider</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={ssoEnabled} onChange={e => setSsoEnabled(e.target.checked)} disabled={!isAdmin} />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      {ssoEnabled && (
        <>
          <div className="sso-section-label">Identity provider</div>
          <div className="provider-grid">
            {PROVIDERS.map(p => (
              <button key={p.value} className={`provider-card ${provider === p.value ? "selected" : ""}`} onClick={() => setProvider(p.value)} disabled={!isAdmin}>
                <div className="provider-logo">{p.logo}</div>
                <div className="provider-name">{p.label}</div>
              </button>
            ))}
          </div>

          <div className="sso-section-label">Protocol</div>
          <div className="filter-group" style={{ marginBottom: "1.25rem" }}>
            <button className={`filter-btn ${protocol === "saml" ? "active" : ""}`} onClick={() => setProtocol("saml")}>SAML 2.0</button>
            <button className={`filter-btn ${protocol === "oidc" ? "active" : ""}`} onClick={() => setProtocol("oidc")}>OIDC</button>
          </div>

          {protocol === "saml" && (
            <div className="sso-card">
              <div className="sso-section-label" style={{ marginBottom: ".75rem" }}>SAML configuration</div>
              <label className="field-label">IdP SSO URL</label>
              <input type="url" placeholder="https://your-idp.com/sso/saml" value={samlConfig.entryPoint} onChange={setSaml("entryPoint")} disabled={!isAdmin} style={{ marginBottom: "1rem" }} />
              <label className="field-label">IdP certificate <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>(PEM format)</span></label>
              <textarea rows={5} placeholder="-----BEGIN CERTIFICATE-----" value={samlConfig.certificate} onChange={setSaml("certificate")} disabled={!isAdmin}
                style={{ width: "100%", padding: "9px 12px", fontSize: 12, fontFamily: "var(--font-mono)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, resize: "vertical", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }} />
              <div className="sp-info">
                <div className="sso-section-label" style={{ marginBottom: ".5rem" }}>Service provider details — share with your IT team</div>
                <div className="sp-row">
                  <span>ACS URL</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <code>https://aureliafms.com/auth/saml/callback</code>
                    <button className="action-btn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => handleCopySP("https://aureliafms.com/auth/saml/callback")}>Copy</button>
                  </div>
                </div>
                <div className="sp-row">
                  <span>Entity ID</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <code>aurelia-fms-{orgId}</code>
                    <button className="action-btn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => handleCopySP(`aurelia-fms-${orgId}`)}>Copy</button>
                  </div>
                </div>
                <div className="sp-row">
                  <span>Name ID format</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <code>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</code>
                    <button className="action-btn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => handleCopySP("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress")}>Copy</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {protocol === "oidc" && (
            <div className="sso-card">
              <div className="sso-section-label" style={{ marginBottom: ".75rem" }}>OIDC configuration</div>
              <label className="field-label">Issuer URL</label>
              <input type="url" placeholder="https://your-idp.com/.well-known/openid-configuration" value={oidcConfig.issuerUrl} onChange={setOidc("issuerUrl")} disabled={!isAdmin} style={{ marginBottom: "1rem" }} />
              <label className="field-label">Client ID</label>
              <input type="text" placeholder="your-client-id" value={oidcConfig.clientId} onChange={setOidc("clientId")} disabled={!isAdmin} style={{ marginBottom: "1rem" }} />
              <label className="field-label">Client secret</label>
              <input type="password" placeholder="••••••••••••" value={oidcConfig.clientSecret} onChange={setOidc("clientSecret")} disabled={!isAdmin} />
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4 }}>Stored encrypted. Leave blank to keep existing secret.</div>
              <div className="sp-info">
                <div className="sso-section-label" style={{ marginBottom: ".5rem" }}>Service provider details — share with your IT team</div>
                <div className="sp-row">
                  <span>Redirect URI</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <code>https://aureliafms.com/auth/oidc/callback</code>
                    <button className="action-btn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => handleCopySP("https://aureliafms.com/auth/oidc/callback")}>Copy</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <div className="sso-section-label" style={{ marginTop: "1.5rem" }}>Access policies</div>
      <div className="sso-card">
        {[
          { label: "Require SSO for all users", desc: "Users can only log in via SSO — password login is disabled", val: ssoOnly, set: setSsoOnly, disabled: !isAdmin || !ssoEnabled },
          { label: "Require MFA for all users", desc: "Enforce multi-factor authentication on every login", val: requireMFA, set: setRequireMFA, disabled: !isAdmin },
        ].map((row, i, arr) => (
          <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "10px 0", borderBottom: i < arr.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{row.label}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{row.desc}</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={row.val} onChange={e => row.set(e.target.checked)} disabled={row.disabled} />
              <span className="toggle-track" />
            </label>
          </div>
        ))}
      </div>

      {error   && <div className="error-banner" style={{ marginTop: "1rem" }}>{error}</div>}
      {success && <div style={{ background: "#EAF3DE", color: "#3B6D11", border: "0.5px solid #C0DD97", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginTop: "1rem" }}>SSO settings saved successfully.</div>}

      {isAdmin && (
        <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save SSO settings"}</button>
        </div>
      )}

      <style>{`
        .sso-card { background: var(--color-background-primary); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); padding: 1rem 1.25rem; margin-bottom: 1rem; }
        .sso-card-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
        .sso-section-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: var(--color-text-tertiary); margin-bottom: .6rem; }
        .provider-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 1.25rem; }
        .provider-card { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 8px; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-primary); cursor: pointer; font-family: var(--font-sans); transition: border-color .15s, background .15s; }
        .provider-card:hover { background: var(--color-background-secondary); }
        .provider-card.selected { border-color: #1D9E75; background: #E1F5EE; }
        .provider-logo { width: 32px; height: 32px; border-radius: 8px; background: var(--color-background-secondary); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 500; color: var(--color-text-secondary); }
        .provider-card.selected .provider-logo { background: #1D9E75; color: #fff; }
        .provider-name { font-size: 12px; color: var(--color-text-secondary); }
        .provider-card.selected .provider-name { color: #0F6E56; font-weight: 500; }
        .field-label { display: block; font-size: 13px; font-weight: 500; color: var(--color-text-secondary); margin-bottom: 6px; }
        .sp-info { margin-top: 1.25rem; padding-top: 1rem; border-top: 0.5px solid var(--color-border-tertiary); }
        .sp-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 5px 0; font-size: 12px; border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
        .sp-row:last-child { border-bottom: none; }
        .sp-row span { color: var(--color-text-tertiary); flex-shrink: 0; }
        .sp-row code { font-family: var(--font-mono); font-size: 11px; background: var(--color-background-secondary); padding: 2px 6px; border-radius: 4px; color: var(--color-text-primary); }
        .toggle { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-track { position: absolute; inset: 0; background: var(--color-border-secondary); border-radius: 20px; cursor: pointer; transition: background .2s; }
        .toggle-track::before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .2s; }
        .toggle input:checked + .toggle-track { background: #1D9E75; }
        .toggle input:checked + .toggle-track::before { transform: translateX(16px); }
        .toggle input:disabled + .toggle-track { opacity: .4; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
