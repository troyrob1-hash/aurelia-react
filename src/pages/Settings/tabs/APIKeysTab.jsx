// src/pages/Settings/tabs/APIKeysTab.jsx
import { useState, useEffect, useCallback } from "react";
import { collection, getDocs, query, orderBy, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../../firebase";
import { useAuth }       from "../../../hooks/useAuth";
import { formatDistanceToNow } from "date-fns";
import Spinner           from "../../../components/Spinner";
import EmptyState        from "../../../components/EmptyState";

const SERVICES = [
  { value: "toast",         label: "Toast POS" },
  { value: "7shifts",       label: "7shifts" },
  { value: "quickbooks",    label: "QuickBooks" },
  { value: "restaurant365", label: "Restaurant365" },
  { value: "sysco",         label: "Sysco" },
  { value: "other",         label: "Other" },
];

const SERVICE_COLORS = {
  toast: "badge-amber", "7shifts": "badge-blue", quickbooks: "badge-green",
  restaurant365: "badge-purple", sysco: "badge-gray", other: "badge-gray",
};

export default function APIKeysTab() {
  const { orgId, user } = useAuth();

  const [keys,      setKeys]      = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [error,     setError]     = useState(null);
  const [filter,    setFilter]    = useState("active");
  const [revealed,  setRevealed]  = useState({});
  const [revealing, setRevealing] = useState({});
  const [copied,    setCopied]    = useState(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [keysSnap, locsSnap] = await Promise.all([
        getDocs(query(
          collection(db, "orgs", orgId, "apiKeys"),
          where("active", "==", filter === "active"),
          orderBy("createdAt", "desc")
        )),
        getDocs(collection(db, "orgs", orgId, "locations")),
      ]);
      setKeys(keysSnap.docs.map(d => d.data()));
      setLocations(locsSnap.docs.map(d => d.data()));
    } catch (e) {
      setError("Failed to load API keys.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [orgId, filter]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const locationName = (id) => id
    ? locations.find(l => l.locationId === id)?.name ?? id
    : "Org-wide";

  const handleReveal = async (keyId) => {
    if (revealed[keyId]) {
      setRevealed(r => { const n = { ...r }; delete n[keyId]; return n; });
      return;
    }
    setRevealing(r => ({ ...r, [keyId]: true }));
    try {
      const fn  = httpsCallable(functions, "getAPIKeyValue");
      const res = await fn({ orgId, keyId });
      setRevealed(r => ({ ...r, [keyId]: res.data.rawKey }));
    } catch (e) {
      alert("Failed to retrieve key: " + e.message);
    } finally {
      setRevealing(r => ({ ...r, [keyId]: false }));
    }
  };

  const handleCopy = async (keyId, value) => {
    await navigator.clipboard.writeText(value);
    setCopied(keyId);
    setTimeout(() => setCopied(c => c === keyId ? null : c), 2000);
  };

  const handleRevoke = async (keyId, label) => {
    if (!window.confirm(`Revoke "${label}"? This cannot be undone.`)) return;
    try {
      const fn = httpsCallable(functions, "revokeAPIKey");
      await fn({ orgId, keyId });
      fetchKeys();
    } catch (e) {
      alert("Failed to revoke key: " + e.message);
    }
  };

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div className="filter-group">
          {["active", "revoked"].map(f => (
            <button key={f} className={`filter-btn ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Add key</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? <Spinner /> : keys.length === 0 ? (
        <EmptyState
          title={filter === "active" ? "No API keys yet" : "No revoked keys"}
          description={filter === "active" ? "Connect your POS, payroll, and accounting integrations." : "Revoked keys will appear here for audit purposes."}
          action={filter === "active" ? { label: "Add key", onClick: () => setShowModal(true) } : null}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Label</th><th>Service</th><th>Scope</th><th>Value</th><th>Last used</th><th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.keyId} className={!k.active ? "row-inactive" : ""}>
                <td style={{ fontWeight: 500 }}>{k.label}</td>
                <td><span className={`badge ${SERVICE_COLORS[k.service] ?? "badge-gray"}`}>{SERVICES.find(s => s.value === k.service)?.label ?? k.service}</span></td>
                <td className="text-secondary" style={{ fontSize: 12 }}>{locationName(k.locationId)}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {revealed[k.keyId] ?? k.maskedValue}
                    </span>
                    {k.active && (
                      <>
                        <button className="action-btn" onClick={() => handleReveal(k.keyId)} disabled={revealing[k.keyId]} style={{ padding: "3px 8px", fontSize: 11 }}>
                          {revealing[k.keyId] ? "..." : revealed[k.keyId] ? "Hide" : "Reveal"}
                        </button>
                        {revealed[k.keyId] && (
                          <button className="action-btn" onClick={() => handleCopy(k.keyId, revealed[k.keyId])} style={{ padding: "3px 8px", fontSize: 11 }}>
                            {copied === k.keyId ? "Copied!" : "Copy"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
                <td className="text-secondary" style={{ fontSize: 12 }}>
                  {k.lastUsedAt ? formatDistanceToNow(k.lastUsedAt.toDate(), { addSuffix: true }) : "Never"}
                </td>
                <td style={{ textAlign: "right" }}>
                  {k.active && <button className="action-btn danger" onClick={() => handleRevoke(k.keyId, k.label)}>Revoke</button>}
                  {!k.active && k.revokedAt && <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Revoked {formatDistanceToNow(k.revokedAt.toDate(), { addSuffix: true })}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <AddKeyModal orgId={orgId} locations={locations} onClose={() => setShowModal(false)} onSuccess={() => { setShowModal(false); fetchKeys(); }} />
      )}
    </div>
  );
}

function AddKeyModal({ orgId, locations, onClose, onSuccess }) {
  const [form,    setForm]    = useState({ label: "", service: "toast", rawKey: "", locationId: "" });
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [showKey, setShowKey] = useState(false);
  const set = f => e => setForm(p => ({ ...p, [f]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.label.trim())  { setError("Label is required.");     return; }
    if (!form.rawKey.trim()) { setError("API key value is required."); return; }
    setSaving(true); setError(null);
    try {
      const fn = httpsCallable(functions, "createAPIKey");
      await fn({ orgId, label: form.label, service: form.service, rawKey: form.rawKey, locationId: form.locationId || null });
      onSuccess();
    } catch (e) {
      setError(e.message ?? "Something went wrong.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add API key</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            The key value is encrypted and stored in GCP Secret Manager. Only the last 4 characters are saved in the database.
          </div>
          <label>Label</label>
          <input type="text" placeholder="Toast POS — Downtown" value={form.label} onChange={set("label")} />
          <label>Service</label>
          <select value={form.service} onChange={set("service")}>
            {SERVICES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <label>Scope</label>
          <select value={form.locationId} onChange={set("locationId")}>
            <option value="">Org-wide</option>
            {locations.filter(l => l.active).map(l => (
              <option key={l.locationId} value={l.locationId}>{l.name}</option>
            ))}
          </select>
          <label>API key value</label>
          <div style={{ position: "relative" }}>
            <input type={showKey ? "text" : "password"} placeholder="Paste your key here" value={form.rawKey} onChange={set("rawKey")} style={{ paddingRight: 70 }} />
            <button onClick={() => setShowKey(s => !s)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "var(--font-sans)" }}>
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : "Add key"}
          </button>
        </div>
      </div>
    </div>
  );
}