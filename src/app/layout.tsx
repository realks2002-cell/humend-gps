import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { NavTabs } from "./nav-tabs";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Humend GPS 테스트",
  description: "위치추적 디버깅용 독립 프로젝트",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b bg-white sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
            <h1 className="text-lg font-bold">Humend GPS</h1>
            <NavTabs />
          </div>
        </header>
        <main className="flex-1 max-w-7xl mx-auto w-full">
          {children}
        </main>
      </body>
    </html>
  );
}
