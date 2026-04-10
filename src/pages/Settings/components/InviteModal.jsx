// src/pages/Settings/components/InviteModal.jsx
import { useState, useEffect } from "react";
import { db, functions } from "@/lib/firebase";
import { httpsCallable } from "firebase/functions";
import { collection, getDocs } from "firebase/firestore";

export default function InviteModal({ orgId, onClose, onSuccess }) {
  const [form, setForm] = useState({
    email: "", displayName: "", role: "manager", locationIds: []
  });
  const [locations, setLocations] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);

  useEffect(() => {
    getDocs(collection(db, "orgs", orgId, "locations"))
      .then(snap => setLocations(snap.docs.map(d => d.data())));
  }, [orgId]);

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const toggleLocation = (id) => {
    setForm(f => ({
      ...f,
      locationIds: f.locationIds.includes(id)
        ? f.locationIds.filter(l => l !== id)
        : [...f.locationIds, id]
    }));
  };

  const handleSubmit = async () => {
    if (!form.email || !form.displayName) {
      setError("Name and email are required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invite = httpsCallable(functions, "inviteUser");
      await invite({ orgId, ...form });
      onSuccess();
    } catch (e) {
      setError(e.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Invite team member</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <label>Full name</label>
          <input
            type="text"
            placeholder="Jane Smith"
            value={form.displayName}
            onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
          />

          <label>Email address</label>
          <input
            type="email"
            placeholder="jane@company.com"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          />

          <label>Role</label>
          <select
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
          >
            <option value="admin">Admin — full access</option>
            <option value="director">Director — assigned locations, no user management</option>
            <option value="manager">Manager — data entry for assigned location</option>
          </select>

          {form.role !== "admin" && locations.length > 0 && (
            <>
              <label>Assign locations</label>
              <div className="location-picker">
                {locations.filter(l => l.active).map(l => (
                  <label key={l.locationId} className="location-option">
                    <input
                      type="checkbox"
                      checked={form.locationIds.includes(l.locationId)}
                      onChange={() => toggleLocation(l.locationId)}
                    />
                    {l.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Sending..." : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}
