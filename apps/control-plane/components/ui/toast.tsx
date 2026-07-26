"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { StatusDot, type Status } from "./status";
type Toast = { id: number; message: string; tone: Status };
const ToastContext = createContext<(message: string, tone?: Status) => void>(() => undefined);
export function ToastProvider({ children }: { children: React.ReactNode }) { const [toasts, setToasts] = useState<Toast[]>([]); const toast = useCallback((message: string, tone: Status = "idle") => { const id = Date.now(); setToasts((items) => [...items, { id, message, tone }]); window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500); }, []); return <ToastContext.Provider value={toast}>{children}<div aria-atomic="true" aria-live="polite" className="cp-toast-region">{toasts.map((item) => <div className="cp-toast" key={item.id} role="status"><StatusDot status={item.tone} />{item.message}</div>)}</div></ToastContext.Provider>; }
export const useToast = () => useContext(ToastContext);
