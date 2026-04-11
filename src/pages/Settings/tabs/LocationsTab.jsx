// src/pages/Settings/tabs/LocationsTab.jsx
import { useState, useEffect, useCallback } from "react";
import {
  collection, query, orderBy,
  getDocs, doc, setDoc, updateDoc,
  serverTimestamp
} from "firebase/firestore";
import { db }       from "@/lib/firebase";
import { useAuth }  from "@/hooks/useAuth";
import { v4 as uuid } from "uuid";
import Spinner      from "@/components/ui/Spinner";
import EmptyState   from "@/components/ui/EmptyState";
import { canAdministerSystem } from "@/lib/permissions";

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const EMPTY_FORM = {
  name: "", shortCode: "", timezone: "America/Chicago",
  street: "", city: "", state: "", zip: "", country: "US", openedDate: "",
};

export default function LocationsTab() {
  const { orgId, user } = useAuth();
  const isAdmin = canAdministerSystem(user);

  const [locations, setLocations] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null);
  const [error,     setError]     = useState(null);

  const fetchLocations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await getDocs(
        query(collection(db, "orgs", orgId, "locations"), orderBy("name"))
      );
      setLocations(snap.docs.map(d => d.data()));
    } catch (e) {
      setError("Failed to load locations.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  const handleSave = async (formData, locationId) => {
    const isNew = !locationId;
    const id    = locationId ?? uuid();
    const now   = serverTimestamp();
    const payload = {
      locationId: id, orgId,
      name:       formData.name.trim(),
      shortCode:  formData.shortCode.trim().toUpperCase(),
      timezone:   formData.timezone,
      address: {
        street: formData.street.trim(), city: formData.city.trim(),
        state:  formData.state.trim(),  zip:  formData.zip.trim(),
        country: formData.country,
      },
      active:     true,
      openedDate: formData.openedDate ? new Date(formData.openedDate) : null,
      ...(isNew ? { createdAt: now, createdBy: user.uid } : {}),
      updatedAt: now,
    };
    await setDoc(doc(db, "orgs", orgId, "locations", id), payload, { merge: true });
    setModal(null);
    fetchLocations();
  };

  const handleDeactivate = async (locationId) => {
    if (!window.confirm("Deactivate this location? Users assigned here will lose access.")) return;
    await updateDoc(doc(db, "orgs", orgId, "locations", locationId), {
      active: false, updatedAt: serverTimestamp()
    });
    fetchLocations();
  };

  const handleReactivate = async (locationId) => {
    await updateDoc(doc(db, "orgs", orgId, "locations", locationId), {
      active: true, updatedAt: serverTimestamp()
    });
    fetchLocations();
  };

  const active   = locations.filter(l => l.active);
  const inactive = locations.filter(l => !l.active);

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          {active.length} active {active.length === 1 ? "location" : "locations"}
        </div>
        {isAdmin && (
          <button className="btn-primary" onClick={() => setModal({ mode: "add" })}>
            + Add location
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? <Spinner /> : locations.length === 0 ? (
        <EmptyState
          title="No locations yet"
          description="Add your first location to start assigning users and tracking data."
          action={isAdmin ? { label: "Add location", onClick: () => setModal({ mode: "add" }) } : null}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th><th>Code</th><th>City</th><th>Timezone</th><th>Status</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {active.map(l => (
                <LocationRow key={l.locationId} location={l} isAdmin={isAdmin}
                  onEdit={() => setModal({ mode: "edit", location: l })}
                  onDeactivate={() => handleDeactivate(l.locationId)} />
              ))}
            </tbody>
          </table>

          {inactive.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--color-text-tertiary)", margin: "1.5rem 0 .6rem" }}>
                Inactive
              </div>
              <table className="data-table">
                <tbody>
                  {inactive.map(l => (
                    <LocationRow key={l.locationId} location={l} isAdmin={isAdmin} inactive
                      onReactivate={() => handleReactivate(l.locationId)} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {modal && (
        <LocationModal mode={modal.mode} location={modal.location}
          onClose={() => setModal(null)} onSave={handleSave} />
      )}
    </div>
  );
}

function LocationRow({ location: l, isAdmin, inactive, onEdit, onDeactivate, onReactivate }) {
  return (
    <tr className={inactive ? "row-inactive" : ""}>
      <td style={{ fontWeight: 500 }}>{l.name}</td>
      <td><span style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--color-background-secondary)", padding: "2px 8px", borderRadius: 6 }}>{l.shortCode}</span></td>
      <td className="text-secondary">{l.address?.city}{l.address?.state ? `, ${l.address.state}` : ""}</td>
      <td className="text-secondary" style={{ fontSize: 12 }}>{l.timezone}</td>
      <td><span className={`badge ${inactive ? "badge-gray" : "badge-green"}`}>{inactive ? "Inactive" : "Active"}</span></td>
      {isAdmin && (
        <td style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {!inactive ? (
            <><button className="action-btn" onClick={onEdit}>Edit</button>
            <button className="action-btn danger" onClick={onDeactivate}>Deactivate</button></>
          ) : (
            <button className="action-btn" onClick={onReactivate}>Reactivate</button>
          )}
        </td>
      )}
    </tr>
  );
}

function LocationModal({ mode, location, onClose, onSave }) {
  const isEdit = mode === "edit";
  const [form, setForm] = useState(
    isEdit ? {
      name: location.name, shortCode: location.shortCode, timezone: location.timezone,
      street: location.address?.street ?? "", city: location.address?.city ?? "",
      state: location.address?.state ?? "", zip: location.address?.zip ?? "",
      country: location.address?.country ?? "US", openedDate: "",
    } : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);
  const set = f => e => setForm(p => ({ ...p, [f]: e.target.value }));

  const handleNameChange = (e) => {
    const name = e.target.value;
    setForm(f => ({
      ...f, name,
      shortCode: f.shortCode || name.split(" ").map(w => w[0]).join("").slice(0, 4).toUpperCase(),
    }));
  };

  const validate = () => {
    if (!form.name.trim())         return "Location name is required.";
    if (!form.shortCode.trim())    return "Short code is required.";
    if (form.shortCode.length > 4) return "Short code must be 4 characters or fewer.";
    if (!form.city.trim())         return "City is required.";
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true); setError(null);
    try {
      await onSave(form, isEdit ? location.locationId : null);
    } catch (e) {
      setError(e.message ?? "Something went wrong.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isEdit ? "Edit location" : "Add location"}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <label>Location name</label>
          <input type="text" placeholder="The Grove — Downtown" value={form.name} onChange={handleNameChange} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>Short code</label>
              <input type="text" placeholder="DT" maxLength={4} value={form.shortCode} onChange={set("shortCode")} style={{ textTransform: "uppercase" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>Timezone</label>
              <select value={form.timezone} onChange={set("timezone")}>
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
          </div>
          <label>Street address</label>
          <input type="text" placeholder="123 Main St" value={form.street} onChange={set("street")} />
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>City</label>
              <input type="text" placeholder="New Orleans" value={form.city} onChange={set("city")} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>State</label>
              <input type="text" placeholder="LA" maxLength={2} value={form.state} onChange={set("state")} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>ZIP</label>
              <input type="text" placeholder="70130" value={form.zip} onChange={set("zip")} />
            </div>
          </div>
          {!isEdit && (
            <>
              <label>Opened date <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>(optional)</span></label>
              <input type="date" value={form.openedDate} onChange={set("openedDate")} />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Save changes" : "Add location"}
          </button>
        </div>
      </div>
    </div>
  );
}