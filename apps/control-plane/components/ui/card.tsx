import type { HTMLAttributes } from "react";
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) { return <section className={`cp-card ${className}`} {...props} />; }
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) { return <div aria-busy="true" aria-label="Loading" className={`cp-skeleton ${className}`} style={style} />; }
