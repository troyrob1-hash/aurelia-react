// src/pages/Settings/tabs/LocationsTab.jsx
import React, { useState, useEffect, useCallback } from "react";
import {
  collection, query, orderBy,
  getDocs, getDoc, doc, setDoc, updateDoc,
  serverTimestamp
} from "firebase/firestore";
import { db }       from "@/lib/firebase";
import { useAuth }  from "@/hooks/useAuth";
import { v4 as uuid } from "uuid";
import Spinner      from "@/components/ui/Spinner";
import EmptyState   from "@/components/ui/EmptyState";
import { canAdministerSystem } from "@/lib/permissions";
import { useLocations } from "@/store/LocationContext";

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
  const { regionsList } = useLocations();
  const isAdmin = canAdministerSystem(user);
  const isDirector = isAdmin || user?.role === 'director' || user?.role === 'Director';

  const [locations, setLocations] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null);
  const [subModal,  setSubModal]  = useState(false);
  const [subParent, setSubParent] = useState('');
  const [subName,   setSubName]   = useState('');
  const [subCode,   setSubCode]   = useState('');
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
      regionId:   formData.regionId || null,
      openedDate: formData.openedDate ? new Date(formData.openedDate) : null,
      ...(isNew ? { createdAt: now, createdBy: user?.email || "unknown" } : {}),
      updatedAt: now,
    };
    await setDoc(doc(db, "orgs", orgId, "locations", id), payload, { merge: true });
    // If assigned to a region, add location to that region's list
    if (formData.regionId) {
      try {
        const regionRef = doc(db, "tenants", orgId, "regions", formData.regionId);
        const regionSnap = await getDoc(regionRef);
        if (regionSnap.exists()) {
          const regionData = regionSnap.data();
          const locations = regionData.locations || [];
          const locName = formData.name.trim();
          if (!locations.includes(locName)) {
            await updateDoc(regionRef, { locations: [...locations, locName] });
          }
        }
      } catch (e) { console.error("Failed to update region:", e); }
    }
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



  // Sub-cafe management
  const getSubCafes = (parentId) => locations.filter(l => l.parentLocationId === parentId);
  
  async function addSubCafe() {
    if (!subName.trim() || !subParent) return;
    const parent = locations.find(l => l.locationId === subParent);
    if (!parent) return;
    const shortCode = subCode.trim() || subName.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const docId = parent.locationId + '_' + subName.trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    try {
      await setDoc(doc(db, 'orgs', orgId, 'locations', docId), {
        locationId: docId,
        name: subName.trim(),
        shortCode,
        type: 'sub-cafe',
        parentLocation: parent.name,
        parentLocationId: parent.locationId,
        active: true,
        director: parent.director || '',
        timezone: parent.timezone || 'America/Los_Angeles',
        address: parent.address || {},
      });
      const parentRef = doc(db, 'orgs', orgId, 'locations', parent.locationId);
      const parentSnap = await getDoc(parentRef);
      const existing = parentSnap.data()?.subLocations || [];
      await updateDoc(parentRef, {
        type: 'parent',
        subLocations: [...existing, docId],
      });
      setSubName(''); setSubCode(''); setSubParent(''); setSubModal(false);
      fetchLocations();
    } catch (e) { console.error(e); setError('Failed to add sub-location'); }
  }

  async function makeParent(loc) {
    if (!window.confirm('Convert "' + loc.name + '" to a parent location with sub-cafes?')) return;
    try {
      await updateDoc(doc(db, 'orgs', orgId, 'locations', loc.locationId), {
        type: 'parent',
        subLocations: [],
      });
      fetchLocations();
    } catch (e) { console.error(e); setError('Failed to update location'); }
  }

  // Separate parents, sub-cafes, and standalones
  const active = locations.filter(l => l.active !== false && l.type !== 'sub-cafe');
  const inactive = locations.filter(l => l.active === false);

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          {active.length} active {active.length === 1 ? "location" : "locations"}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={() => setModal({ mode: "add" })}>
              + Add location
            </button>
            <button onClick={() => setSubModal(true)} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'rgba(29,158,117,0.08)', color: '#1D9E75', border: '1px solid rgba(29,158,117,0.2)', borderRadius: 8, cursor: 'pointer' }}>
              + Add sub-location
            </button>
          </div>
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
          <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 800 }}>
            <thead>
              <tr>
                <th>Name</th><th>Code</th><th>Type</th><th>City</th><th>Timezone</th><th>Status</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {active.map(l => (
                <React.Fragment key={l.locationId}>
                  <LocationRow location={l} isAdmin={isAdmin}
                    onEdit={() => setModal({ mode: "edit", location: l })}
                    onDeactivate={() => handleDeactivate(l.locationId)} />
                  {l.type === 'parent' && getSubCafes(l.locationId).map(sub => (
                    <LocationRow key={sub.locationId || sub.name} location={sub} isAdmin={isAdmin} isSub
                      onEdit={() => setModal({ mode: "edit", location: sub })}
                      onDeactivate={() => handleDeactivate(sub.locationId)} />
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          </div>

          {inactive.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--color-text-tertiary)", margin: "1.5rem 0 .6rem" }}>
                Inactive
              </div>
              <div style={{ overflowX: "auto" }}>
          <table className="data-table">
                <tbody>
                  {inactive.map(l => (
                    <LocationRow key={l.locationId} location={l} isAdmin={isAdmin} inactive
                      onReactivate={() => handleReactivate(l.locationId)} />
                  ))}
                </tbody>
              </table>
          </div>
            </>
          )}
        </>
      )}

      {modal && (
        <LocationModal mode={modal.mode} location={modal.location} regionsList={regionsList}
          onClose={() => setModal(null)} onSave={handleSave} />
      )}

      {subModal && (
        <div className="modal-overlay" onClick={() => setSubModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Add sub-location</h2>
              <button className="modal-close" onClick={() => setSubModal(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Parent location</label>
                <select value={subParent} onChange={e => setSubParent(e.target.value)}
                  style={{ padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, background: 'var(--color-background-primary)' }}>
                  <option value="">Where will this sub-location live?</option>
                  {locations.filter(l => l.active !== false && l.type !== 'sub-cafe').map(l => (
                    <option key={l.locationId} value={l.locationId}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Sub-location name</label>
                <input value={subName} onChange={e => setSubName(e.target.value)}
                  placeholder="e.g. Cafe AZ"
                  style={{ padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 500 }}>Short code</label>
                <input value={subCode} onChange={e => setSubCode(e.target.value)}
                  placeholder="e.g. AZ"
                  style={{ padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, maxWidth: 120 }} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSubModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={addSubCafe} disabled={!subParent || !subName.trim()}>
                Add sub-location
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LocationRow({ location: l, isAdmin, inactive, onEdit, onDeactivate, onReactivate, isSub }) {
  return (
    <>
      <tr className={inactive ? "row-inactive" : ""} style={isSub ? { background: 'var(--color-background-secondary)' } : {}}>
        <td style={{ fontWeight: 500, paddingLeft: isSub ? 32 : 12 }}>
          {isSub && <span style={{ color: 'var(--color-text-tertiary)', marginRight: 6 }}>↳</span>}
          {l.name}
        </td>
        <td><span style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--color-background-secondary)", padding: "2px 8px", borderRadius: 6 }}>{l.shortCode}</span></td>
        <td>
          {l.type === 'parent' && <span className="badge badge-blue" style={{ fontSize: 10 }}>Parent</span>}
          {l.type === 'sub-cafe' && <span className="badge badge-gray" style={{ fontSize: 10 }}>Sub-cafe</span>}
          {!l.type && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Standalone</span>}
        </td>
        <td className="text-secondary">{l.address?.city}{l.address?.state ? `, ${l.address.state}` : ""}</td>
        <td className="text-secondary" style={{ fontSize: 12 }}>{l.timezone}</td>
        <td><span className={`badge ${inactive ? "badge-gray" : "badge-green"}`}>{inactive ? "Inactive" : "Active"}</span></td>
        {isAdmin && (
          <td style={{ textAlign: "right", whiteSpace: 'nowrap' }}>
            {!inactive ? (
              <>
                <button className="action-btn" onClick={onEdit}>Edit</button>
                <button className="action-btn danger" onClick={onDeactivate} style={{ marginLeft: 6, color: '#dc2626', borderColor: '#fca5a5' }}>Deactivate</button>
              </>
            ) : (
              <button className="action-btn" onClick={onReactivate}>Reactivate</button>
            )}
          </td>
        )}
      </tr>


    </>
  );
}

function LocationModal({ mode, location, onClose, onSave, regionsList = [] }) {
  const isEdit = mode === "edit";
  const [form, setForm] = useState(
    isEdit ? {
      name: location.name, shortCode: location.shortCode, timezone: location.timezone,
      street: location.address?.street ?? "", city: location.address?.city ?? "",
      state: location.address?.state ?? "", zip: location.address?.zip ?? "",
      country: location.address?.country ?? "US", openedDate: "",
      regionId: location.regionId || "",
    } : { ...EMPTY_FORM, regionId: "" }
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
          <label>Region</label>
          <select value={form.regionId} onChange={set("regionId")}>
            <option value="">— No region —</option>
            {regionsList.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
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