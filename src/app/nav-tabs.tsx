"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/", label: "테스트" },
  { href: "/dashboard", label: "대시보드" },
];

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1">
      {tabs.map(({ href, label }) => {
        const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-md transition-colors",
              isActive
                ? "bg-gray-900 text-white"
                : "text-gray-600 hover:bg-gray-100"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
