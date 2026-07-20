import { Analytics } from "@vercel/analytics/next";

export const metadata = {
  title: "Manifold — control plane",
  description: "OpenAI-compatible self-hostable AI gateway with logging and governance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          background: "#0b0b0c",
          color: "#e7e7ea",
        }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
