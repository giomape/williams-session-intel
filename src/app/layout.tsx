import type { Metadata } from "next";
import "@/app/globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Williams Session Intel";

export const metadata: Metadata = {
  title: appName,
  description: "Live-style historical session dashboard"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
