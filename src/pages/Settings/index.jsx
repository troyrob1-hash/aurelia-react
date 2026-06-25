import { useState, useEffect } from "react";
import UsersTab     from "./tabs/UsersTab";
import RegionsTab   from "./tabs/RegionsTab";
import LocationsTab from "./tabs/LocationsTab";
import APIKeysTab   from "./tabs/APIKeysTab";
import AuditLogTab  from "./tabs/AuditLogTab";
import SSOTab       from "./tabs/SSOTab";
import DataBrowserTab from "./tabs/DataBrowserTab";
import IntegrationMapTab from "./tabs/IntegrationMapTab";
import InventoryCategoriesTab from "./tabs/InventoryCategoriesTab";
import SyncStatusPanel from "@/components/SyncStatusPanel";import Breadcrumb   from "@/components/ui/Breadcrumb";
import { useAuth }  from "@/hooks/useAuth";
import { canAdministerSystem } from "@/lib/permissions";

const TABS = [
  { id: "users",     label: "Users & roles",  adminOnly: true  },
  { id: "regions",   label: "Regions",         adminOnly: true  },
  { id: "locations", label: "Locations",       adminOnly: true  },
  { id: "inventoryCategories", label: "Inventory categories", adminOnly: true },
  { id: "apikeys",   label: "Integrations",    adminOnly: true  },
  { id: "audit",     label: "Activity",        adminOnly: true  },
  { id: "sso",       label: "Single sign-on",  adminOnly: true  },
  { id: "data",     label: "Data browser",    adminOnly: true  },
];

export default function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("users");
  const [subTab, setSubTab] = useState("map");
  const isAdmin = canAdministerSystem(user);
  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);
  // If the current tab isn't visible to this user (e.g. a non-admin whose
  // default landed on an admin-only tab), fall back to the first visible tab.
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some(t => t.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [visibleTabs, activeTab]);
  const activeLabel = TABS.find(t => t.id === activeTab)?.label ?? "";

  return (
    <div className="settings-page">
      <div className="settings-header">
        <Breadcrumb items={["Settings", activeLabel]} />
        <h1>Settings</h1>
        <p className="settings-subtitle">Manage your organization, users, and integrations</p>
      </div>
      <nav className="settings-tabs">
        {visibleTabs.map(t => (
          <button
            key={t.id}
            className={`settings-tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="settings-panel">
        {activeTab === "users"     && <UsersTab />}
        {activeTab === "regions"   && <RegionsTab />}
        {activeTab === "locations" && <LocationsTab />}
        {activeTab === "inventoryCategories" && <InventoryCategoriesTab />}
        {activeTab === "apikeys"   && (
          <div>
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e2e8f0', marginBottom: 20 }}>
              <button onClick={() => setSubTab('map')} style={{
                padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                background: 'transparent',
                color: subTab === 'map' ? '#0369a1' : '#64748b',
                borderBottom: subTab === 'map' ? '2px solid #0369a1' : '2px solid transparent',
                marginBottom: -1,
              }}>Integration map</button>
              <button onClick={() => setSubTab('sync')} style={{
                padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                background: 'transparent',
                color: subTab === 'sync' ? '#0369a1' : '#64748b',
                borderBottom: subTab === 'sync' ? '2px solid #0369a1' : '2px solid transparent',
                marginBottom: -1,
              }}>Sync status</button>
              <button onClick={() => setSubTab('keys')} style={{
                padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                background: 'transparent',
                color: subTab === 'keys' ? '#0369a1' : '#64748b',
                borderBottom: subTab === 'keys' ? '2px solid #0369a1' : '2px solid transparent',
                marginBottom: -1,
              }}>API keys</button>
            </div>
            {subTab === 'map' && <IntegrationMapTab />}
            {subTab === 'sync' && <SyncStatusPanel />}
            {subTab === 'keys' && <APIKeysTab />}
          </div>
        )}
        {activeTab === "audit"     && <AuditLogTab />}
        {activeTab === "sso"       && <SSOTab />}
        {activeTab === "data"     && <DataBrowserTab />}
      </div>
    </div>
  );
}
