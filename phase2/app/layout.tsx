import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "智匯｜企業部門知識問答平台",
    description: "整合部門專屬知識庫、AI 問答引用、Excel 匯入匯出與知識維運後台。",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "智匯｜企業部門知識問答平台",
      description: "讓每個部門，都有一位懂內部知識的 AI 助理。",
      type: "website",
      url: origin,
      images: [{ url: `${origin}/og-phase2.png`, width: 1200, height: 630, alt: "智匯企業部門知識問答平台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "智匯｜企業部門知識問答平台",
      description: "部門專屬知識庫、可追溯引用與 Excel 維運後台",
      images: [`${origin}/og-phase2.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
