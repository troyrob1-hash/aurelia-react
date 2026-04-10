// src/components/ui/Toast.jsx
import { createContext, useContext, useState, useCallback } from "react";

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, []);

  const toast = {
    success: (msg) => addToast(msg, "success"),
    error:   (msg) => addToast(msg, "error"),
    info:    (msg) => addToast(msg, "info"),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 2000, display: "flex", flexDirection: "column-reverse", gap: 8 }}>
        {toasts.map(t => (
          <ToastItem key={t.id} message={t.message} type={t.type} onDismiss={() => setToasts(prev => prev.filter(x => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ message, type, onDismiss }) {
  const colors = {
    success: { bg: "#EAF3DE", color: "#3B6D11", border: "#C0DD97", icon: "✓" },
    error:   { bg: "#FCEBEB", color: "#A32D2D", border: "#F7C1C1", icon: "✕" },
    info:    { bg: "#E6F1FB", color: "#185FA5", border: "#B8D4F0", icon: "ℹ" },
  };
  const c = colors[type] || colors.success;

  return (
    <div
      onClick={onDismiss}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 20px", borderRadius: 10, cursor: "pointer",
        background: c.bg, color: c.color, border: `0.5px solid ${c.border}`,
        fontSize: 13, fontWeight: 500, fontFamily: "var(--font-sans)",
        boxShadow: "0 4px 16px rgba(0,0,0,.1)",
        animation: "toast-in .3s ease",
      }}
    >
      <span style={{ fontSize: 16, lineHeight: 1 }}>{c.icon}</span>
      {message}
    </div>
  );
}

// Default export for backward compat with direct import
export default { ToastProvider, useToast };
