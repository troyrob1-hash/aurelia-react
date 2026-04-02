import { useState } from "react";
import UsersTab     from "./tabs/UsersTab";
import LocationsTab from "./tabs/LocationsTab";
import APIKeysTab   from "./tabs/APIKeysTab";
import AuditLogTab  from "./tabs/AuditLogTab";
import SSOTab       from "./tabs/SSOTab";
import { useAuth }  from "@/hooks/useAuth";

const TABS = [
  { id: "users",     label: "Users & roles",  adminOnly: false },
  { id: "locations", label: "Locations",       adminOnly: true  },
  { id: "apikeys",   label: "API keys",        adminOnly: true  },
  { id: "audit",     label: "Audit log",       adminOnly: true  },
  { id: "sso",       label: "Single sign-on",  adminOnly: true  },
];

export default function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("users");
  const isAdmin = user?.role === "admin";
  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="settings-page">
      <div className="settings-header">
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
        {activeTab === "locations" && <LocationsTab />}
        {activeTab === "apikeys"   && <APIKeysTab />}
        {activeTab === "audit"     && <AuditLogTab />}
        {activeTab === "sso"       && <SSOTab />}
      </div>
    </div>
  );
}