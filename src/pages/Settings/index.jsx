import { useState } from "react";
import UsersTab     from "./tabs/UsersTab";
import LocationsTab from "./tabs/LocationsTab";
import APIKeysTab   from "./tabs/APIKeysTab";
import AuditLogTab  from "./tabs/AuditLogTab";
import SSOTab       from "./tabs/SSOTab";
import Breadcrumb   from "@/components/ui/Breadcrumb";
import { useAuth }  from "@/hooks/useAuth";

const TABS = [
  { id: "users",     label: "Users & roles",  adminOnly: false },
  { id: "locations", label: "Locations",       adminOnly: true  },
  { id: "apikeys",   label: "Integrations",    adminOnly: true  },
  { id: "audit",     label: "Activity",        adminOnly: true  },
  { id: "sso",       label: "Single sign-on",  adminOnly: true  },
];

export default function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("users");
  const isAdmin = user?.role === "admin";
  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);
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
        {activeTab === "locations" && <LocationsTab />}
        {activeTab === "apikeys"   && <APIKeysTab />}
        {activeTab === "audit"     && <AuditLogTab />}
        {activeTab === "sso"       && <SSOTab />}
      </div>
    </div>
  );
}
