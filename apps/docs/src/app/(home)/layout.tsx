import type { ReactNode } from "react";
import { ProductHeader } from "@/components/product-header";
import "./landing.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <ProductHeader />
      {children}
    </>
  );
}
