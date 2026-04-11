// src/pages/Settings/tabs/RegionsTab.jsx
//
// Regions are buckets of location names used for director/manager access control.
// Admins can create, rename, delete, and reorganize regions. When a region is
// deleted, the backend cascades the cleanup into users' managedRegionIds arrays.
//
// NOTE: This tab reads location names from tenants/{orgId}/legacy/inv_locs
// (the canonical source used by Weekly Sales and the seed script), NOT from
// orgs/{orgId}/locations which is a separate list used by the Locations tab.
// This split is tracked in FOLLOWUPS.md as "reconcile locations two-path split".

import { useState, useEffect, useMemo } from "react";
import { doc, onSnapshot, collection } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { cleanLocName } from "@/store/LocationContext";
import Spinner from "@/components/ui/Spinner";
import EmptyState from "@/components/ui/EmptyState";

export default function RegionsTab() {
  const { orgId } = useAuth();
  const toast = useToast();

  const [regions, setRegions] = useState([]);
  const [allLocationNames, setAllLocationNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRegion, setEditingRegion] = useState(null);  // null | region object | 'new'
  const [saving, setSaving] = useState(false);

  // Subscribe to regions collection
  useEffect(() => {
    if (!orgId) return;
    const ref = collection(db, "tenants", orgId, "regions");
    const unsub = onSnapshot(
      ref,
      snap => {
        const next = [];
        snap.forEach(d => next.push({ id: d.id, ...d.data() }));
        next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setRegions(next);
        setLoading(false);
      },
      err => {
        console.error("Failed to load regions:", err);
        toast.error("Failed to load regions");
        setLoading(false);
      }
    );
    return unsub;
  }, [orgId, toast]);

  // Subscribe to locations (from the legacy inv_locs doc — same source as Weekly Sales)
  useEffect(() => {
    if (!orgId) return;
    const ref = doc(db, "tenants", orgId, "legacy", "inv_locs");
    const unsub = onSnapshot(
      ref,
      snap => {
        if (snap.exists()) {
          const data = snap.data().value || {};
          setAllLocationNames(Object.keys(data).sort());
        }
      },
      err => console.error("Failed to load locations:", err)
    );
    return unsub;
  }, [orgId]);

  // Compute which locations are already assigned to any region
  const assignedLocationCount = useMemo(() => {
    const counts = {};
    regions.forEach(r => {
      (r.locations || []).forEach(name => {
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    return counts;
  }, [regions]);

  const unassignedLocations = useMemo(() => {
    return allLocationNames.filter(name => !assignedLocationCount[name]);
  }, [allLocationNames, assignedLocationCount]);

  const totalLocations = allLocationNames.length;
  const coveredLocations = Object.keys(assignedLocationCount).length;

  async function handleSave(formData, regionId) {
    setSaving(true);
    try {
      const callable = httpsCallable(functions, "updateRegion");
      await callable({
        orgId,
        action: regionId ? "update" : "create",
        regionId,
        name: formData.name,
        locations: formData.locations,
      });
      toast.success(regionId ? "Region updated" : "Region created");
      setEditingRegion(null);
    } catch (e) {
      console.error("Region save failed:", e);
      toast.error(e.message || "Failed to save region");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(region) {
    if (!window.confirm(
      `Delete region "${region.name}"?\n\nThis will:\n• Remove ${(region.locations || []).length} locations from this region\n• Unassign this region from any directors who have it in their managedRegionIds\n\nLocations themselves will NOT be deleted.`
    )) return;

    setSaving(true);
    try {
      const callable = httpsCallable(functions, "updateRegion");
      const result = await callable({
        orgId,
        action: "delete",
        regionId: region.id,
      });
      const affected = result.data?.affectedUsers || 0;
      toast.success(
        affected > 0
          ? `Region deleted · ${affected} user${affected !== 1 ? "s" : ""} updated`
          : "Region deleted"
      );
    } catch (e) {
      console.error("Region delete failed:", e);
      toast.error(e.message || "Failed to delete region");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {/* Header summary */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 14, color: "#64748b" }}>
            {regions.length} region{regions.length !== 1 ? "s" : ""} · {coveredLocations} of {totalLocations} locations assigned
            {unassignedLocations.length > 0 && (
              <span style={{ color: "#f59e0b", marginLeft: 8 }}>
                · {unassignedLocations.length} unassigned
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => setEditingRegion("new")}
          style={{
            padding: "8px 16px",
            background: "#1D9E75",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 500,
            fontSize: 13,
          }}
        >
          + New region
        </button>
      </div>

      {/* Regions list */}
      {regions.length === 0 ? (
        <EmptyState
          title="No regions yet"
          description="Create your first region to start organizing locations for access control."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {regions.map(region => (
            <div
              key={region.id}
              style={{
                padding: "14px 18px",
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                gap: 16,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 3 }}>
                  {region.name}
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {(region.locations || []).length} location{(region.locations || []).length !== 1 ? "s" : ""}
                  {(region.locations || []).length > 0 && (
                    <span style={{ color: "#94a3b8" }}>
                      {" · "}
                      {(region.locations || []).slice(0, 3).map(cleanLocName).join(", ")}
                      {(region.locations || []).length > 3 && ` +${(region.locations || []).length - 3} more`}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setEditingRegion(region)}
                style={{
                  padding: "6px 12px",
                  background: "#f8fafc",
                  color: "#475569",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                Edit
              </button>
              <button
                onClick={() => handleDelete(region)}
                disabled={saving}
                style={{
                  padding: "6px 12px",
                  background: "#fff",
                  color: "#dc2626",
                  border: "1px solid #fca5a5",
                  borderRadius: 6,
                  cursor: saving ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Edit/Create modal */}
      {editingRegion && (
        <RegionModal
          region={editingRegion === "new" ? null : editingRegion}
          allLocationNames={allLocationNames}
          otherRegions={regions.filter(r => editingRegion === "new" || r.id !== editingRegion.id)}
          onSave={handleSave}
          onClose={() => setEditingRegion(null)}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Edit/Create Modal ────────────────────────────────────────
function RegionModal({ region, allLocationNames, otherRegions, onSave, onClose, saving }) {
  const [name, setName] = useState(region?.name || "");
  const [selectedLocations, setSelectedLocations] = useState(new Set(region?.locations || []));
  const [searchTerm, setSearchTerm] = useState("");

  // Compute which locations are assigned to OTHER regions (for warning badges)
  const locationsInOtherRegions = useMemo(() => {
    const map = {};
    otherRegions.forEach(r => {
      (r.locations || []).forEach(name => {
        map[name] = r.name;
      });
    });
    return map;
  }, [otherRegions]);

  const filteredLocations = useMemo(() => {
    if (!searchTerm) return allLocationNames;
    const term = searchTerm.toLowerCase();
    return allLocationNames.filter(name => name.toLowerCase().includes(term));
  }, [allLocationNames, searchTerm]);

  function toggleLocation(name) {
    setSelectedLocations(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function handleSelectAll() {
    setSelectedLocations(new Set(filteredLocations));
  }

  function handleClearAll() {
    setSelectedLocations(new Set());
  }

  function handleSubmit() {
    if (!name.trim()) {
      alert("Region name is required");
      return;
    }
    onSave(
      { name: name.trim(), locations: Array.from(selectedLocations) },
      region?.id
    );
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000, padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff", borderRadius: 14, padding: 0,
          maxWidth: 640, width: "100%", maxHeight: "85vh",
          display: "flex", flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #e5e7eb" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#0f172a" }}>
            {region ? "Edit region" : "Create region"}
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>
            Regions group locations so admins can assign multiple locations to a director in one click.
          </p>
        </div>

        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 6 }}>
            Region name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Troy Robinson, Northeast, West Coast"
            autoFocus
            style={{
              width: "100%", padding: "10px 12px", fontSize: 14,
              border: "1px solid #e2e8f0", borderRadius: 8,
              marginBottom: 20, fontFamily: "inherit",
            }}
          />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
              Locations ({selectedLocations.size} selected)
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleSelectAll}
                style={{ fontSize: 11, padding: "3px 8px", background: "none", border: "none", color: "#1D9E75", cursor: "pointer", fontWeight: 500 }}
              >
                Select all{searchTerm && " filtered"}
              </button>
              <button
                onClick={handleClearAll}
                style={{ fontSize: 11, padding: "3px 8px", background: "none", border: "none", color: "#64748b", cursor: "pointer", fontWeight: 500 }}
              >
                Clear
              </button>
            </div>
          </div>

          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search locations..."
            style={{
              width: "100%", padding: "8px 12px", fontSize: 13,
              border: "1px solid #e2e8f0", borderRadius: 6,
              marginBottom: 8, fontFamily: "inherit",
            }}
          />

          <div style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            maxHeight: 320,
            overflowY: "auto",
            background: "#fafbfc",
          }}>
            {filteredLocations.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                No locations match "{searchTerm}"
              </div>
            ) : (
              filteredLocations.map(name => {
                const checked = selectedLocations.has(name);
                const conflict = !checked && locationsInOtherRegions[name];
                return (
                  <label
                    key={name}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "9px 12px",
                      cursor: "pointer",
                      borderBottom: "1px solid #f1f5f9",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleLocation(name)}
                      style={{ cursor: "pointer" }}
                    />
                    <span style={{ flex: 1, color: "#0f172a" }}>{cleanLocName(name)}</span>
                    {conflict && (
                      <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 500 }}>
                        in "{conflict}"
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
            Note: a location can belong to multiple regions. Locations highlighted in amber are currently assigned to another region as well.
          </div>
        </div>

        <div style={{
          padding: "16px 24px",
          borderTop: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 16px",
              background: "#fff",
              color: "#475569",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              cursor: saving ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
            style={{
              padding: "8px 20px",
              background: saving || !name.trim() ? "#94a3b8" : "#1D9E75",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: saving || !name.trim() ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}
          >
            {saving ? "Saving..." : region ? "Save changes" : "Create region"}
          </button>
        </div>
      </div>
    </div>
  );
}
