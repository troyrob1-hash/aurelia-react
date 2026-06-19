// src/pages/Settings/components/InviteModal.jsx
//
// Rewritten for the 4-role RBAC model. Creates a new user with:
//   - roles[] (manager, director, vp, admin — additive)
//   - managedRegionIds[] for region-based access
//   - assignedLocations[] for ad-hoc location overrides
//
// Sends the new-shape payload to the updated inviteUser Cloud Function.
// Uses the same UI patterns as EditAccessModal for consistency.

import { useState, useMemo } from "react";
import { functions } from "@/lib/firebase";
import { httpsCallable } from "firebase/functions";
import { useLocations, cleanLocName } from "@/store/LocationContext";
import { ASSIGNABLE_ROLES } from "@/lib/permissions";

export default function InviteModal({ orgId, onClose, onSuccess, prefillEmail, prefillName }) {
  const { allLocations, regionsList } = useLocations();

  const [email, setEmail] = useState(prefillEmail || "");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState(["manager"]);
  const [managedRegionIds, setManagedRegionIds] = useState([]);
  const [assignedLocations, setAssignedLocations] = useState([]);
  const [locationSearch, setLocationSearch] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const seesAll = roles.includes("vp") || roles.includes("admin");
  const needsRegions = !seesAll && (roles.includes("director") || roles.includes("manager"));

  function toggleRole(role) {
    setRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  }
  function toggleRegion(regionId) {
    setManagedRegionIds(prev => prev.includes(regionId) ? prev.filter(id => id !== regionId) : [...prev, regionId]);
  }
  function toggleLocation(name) {
    setAssignedLocations(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  }

  const coveredByRegions = useMemo(() => {
    const set = new Set();
    managedRegionIds.forEach(id => {
      const region = regionsList.find(r => r.id === id);
      (region?.locations || []).forEach(name => set.add(name));
    });
    return set;
  }, [managedRegionIds, regionsList]);

  const filteredLocations = useMemo(() => {
    const term = locationSearch.trim().toLowerCase();
    return allLocations.filter(loc => {
      if (!loc?.name) return false;
      if (term && !loc.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [allLocations, locationSearch]);

  async function handleSubmit() {
    if (!email.trim() || !displayName.trim()) {
      setError("Name and email are required.");
      return;
    }
    if (roles.length === 0) {
      setError("Select at least one role.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invite = httpsCallable(functions, "inviteUser");
      const result = await invite({
        orgId,
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        roles,
        managedRegionIds: seesAll ? [] : managedRegionIds,
        assignedLocations: seesAll ? [] : assignedLocations,
      });
      const pw = result?.data?.tempPassword || "Welcome2026!";
      window.alert("Account created for " + displayName.trim() + "\n\nEmail: " + email.trim() + "\nTemp password: " + pw + "\n\nShare this with them — they\'ll set a new password on first login.");
      onSuccess();
    } catch (e) {
      setError(e.message || "Failed to send invitation.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 14,
          maxWidth: 620, width: "100%", maxHeight: "90vh",
          display: "flex", flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#0f172a" }}>Invite team member</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 20, color: "#94a3b8", cursor: "pointer", padding: 4 }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          {error && (
            <div style={{ padding: "10px 12px", background: "#fee2e2", color: "#991b1b", borderRadius: 8, marginBottom: 16, fontSize: 12 }}>
              {error}
            </div>
          )}

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 6 }}>
            Full name
          </label>
          <input
            type="text"
            placeholder="Jane Smith"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            style={{
              width: "100%", padding: "10px 12px", fontSize: 13,
              border: "1px solid #e2e8f0", borderRadius: 8,
              marginBottom: 16, fontFamily: "inherit",
            }}
          />

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 6 }}>
            Email address
          </label>
          <input
            type="email"
            placeholder="jane@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={{
              width: "100%", padding: "10px 12px", fontSize: 13,
              border: "1px solid #e2e8f0", borderRadius: 8,
              marginBottom: 20, fontFamily: "inherit",
            }}
          />

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 10 }}>
            Roles <span style={{ color: "#94a3b8", fontWeight: 400 }}>(can hold multiple)</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {ASSIGNABLE_ROLES.map(r => {
              const checked = roles.includes(r.value);
              return (
                <label
                  key={r.value}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "10px 12px",
                    border: "1px solid " + (checked ? "#1D9E75" : "#e5e7eb"),
                    background: checked ? "#f0fdf4" : "#fff",
                    borderRadius: 8, cursor: "pointer",
                    transition: "all 0.12s",
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggleRole(r.value)} style={{ marginTop: 2, cursor: "pointer" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{r.label}</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{r.hint}</div>
                  </div>
                </label>
              );
            })}
          </div>

          {needsRegions && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 8 }}>
                Managed regions ({managedRegionIds.length} selected)
              </label>
              {regionsList.length === 0 ? (
                <div style={{ fontSize: 12, color: "#94a3b8", padding: 12, background: "#f8fafc", borderRadius: 8, textAlign: "center" }}>
                  No regions exist yet. Create regions in the Regions tab first.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 8, padding: 4 }}>
                  {regionsList.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(region => {
                    const checked = managedRegionIds.includes(region.id);
                    return (
                      <label
                        key={region.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "8px 10px",
                          background: checked ? "#f0fdf4" : "transparent",
                          borderRadius: 6, cursor: "pointer", fontSize: 13,
                        }}
                      >
                        <input type="checkbox" checked={checked} onChange={() => toggleRegion(region.id)} style={{ cursor: "pointer" }} />
                        <span style={{ flex: 1, color: "#0f172a" }}>{region.name}</span>
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>
                          {(region.locations || []).length} location{(region.locations || []).length !== 1 ? "s" : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {needsRegions && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 8 }}>
                Ad-hoc location assignments ({assignedLocations.length} selected)
              </label>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
                Optional. Use for one-off location access outside a region.
              </div>
              <input
                type="text"
                value={locationSearch}
                onChange={e => setLocationSearch(e.target.value)}
                placeholder="Search locations..."
                style={{
                  width: "100%", padding: "7px 10px", fontSize: 12,
                  border: "1px solid #e2e8f0", borderRadius: 6,
                  marginBottom: 6, fontFamily: "inherit",
                }}
              />
              <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                {filteredLocations.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
                    No locations match
                  </div>
                ) : (
                  filteredLocations.map(loc => {
                    const checked = assignedLocations.includes(loc.name);
                    const covered = coveredByRegions.has(loc.name);
                    return (
                      <label
                        key={loc.id || loc.name}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "7px 10px",
                          borderBottom: "1px solid #f1f5f9",
                          fontSize: 12, cursor: "pointer",
                          opacity: covered ? 0.5 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLocation(loc.name)}
                          disabled={covered}
                          style={{ cursor: covered ? "not-allowed" : "pointer" }}
                        />
                        <span style={{ flex: 1, color: "#0f172a" }}>{cleanLocName(loc.name)}</span>
                        {covered && (
                          <span style={{ fontSize: 10, color: "#94a3b8", fontStyle: "italic" }}>
                            covered by region
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {seesAll && (
            <div style={{ fontSize: 12, color: "#1D9E75", padding: "10px 12px", background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
              {roles.includes("admin") ? "Admin" : "Vice President"} sees all locations automatically — no region or ad-hoc assignments needed.
            </div>
          )}
        </div>

        <div style={{
          padding: "14px 24px",
          borderTop: "1px solid #e5e7eb",
          display: "flex", justifyContent: "flex-end", gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: "8px 16px", background: "#fff", color: "#475569",
              border: "1px solid #e2e8f0", borderRadius: 8,
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || roles.length === 0 || !email.trim() || !displayName.trim()}
            style={{
              padding: "8px 20px",
              background: loading || roles.length === 0 || !email.trim() || !displayName.trim() ? "#94a3b8" : "#1D9E75",
              color: "#fff", border: "none", borderRadius: 8,
              cursor: loading || roles.length === 0 ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}
          >
            {loading ? "Sending..." : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}
