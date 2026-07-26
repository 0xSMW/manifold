import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";
import "../components/shell/shell.css";
import "../components/console/console.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: "Manifold control plane",
  description: "OpenAI-compatible self-hostable AI gateway with logging and governance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html className={`${geistSans.variable} ${geistMono.variable}`} lang="en" suppressHydrationWarning>
      <body>
        <ToastProvider>
          <Suspense fallback={<main aria-busy="true" style={{ padding: 24 }}>Loading control plane…</main>}>
            {children}
          </Suspense>
        </ToastProvider>
        <Analytics />
      </body>
    </html>
  );
}
