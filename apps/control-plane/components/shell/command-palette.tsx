"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/field";
import type { ShellNavItem } from "./types";

export function CommandPalette({ items }: { items: ShellNavItem[] }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(""); const [active, setActive] = useState(0); const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => items.filter((item) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  useEffect(() => { const handle = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen((value) => !value); } if (event.key === "Escape") setOpen(false); if (!open) return; if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, matches.length - 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); } if (event.key === "Enter" && matches[active]) window.location.assign(matches[active].href); }; document.addEventListener("keydown", handle); return () => document.removeEventListener("keydown", handle); }, [active, matches, open]);
  useEffect(() => { if (open) { setQuery(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  if (!open) return <button aria-label="Open command palette" className="shell-command-trigger" onClick={() => setOpen(true)}><span>Search</span><kbd>⌘K</kbd></button>;
  return <div className="cp-dialog-backdrop" onMouseDown={() => setOpen(false)} role="presentation"><div aria-label="Command palette" aria-modal="true" className="shell-command-palette" onMouseDown={(event) => event.stopPropagation()} role="dialog"><Input aria-label="Search pages" onChange={(event) => setQuery(event.target.value)} placeholder="Search pages" ref={inputRef} value={query} /><div className="shell-command-list" role="listbox">{matches.length ? matches.map((item, index) => <button aria-selected={index === active} className="shell-command-item" data-active={index === active || undefined} key={item.href} onClick={() => window.location.assign(item.href)} onMouseEnter={() => setActive(index)} role="option"><span>{item.label}</span><span className="cp-mono">{item.href}</span></button>) : <p className="shell-command-empty">No matching pages</p>}</div></div></div>;
}
