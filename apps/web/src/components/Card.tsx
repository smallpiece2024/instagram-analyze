import type { ReactNode } from "react";

export interface CardProps {
  title?: ReactNode;
  /** 見出しの右の補足 */
  sub?: ReactNode;
  /** カードの下の注記（データの時点と日付の区切りを必ず書く。R3 設計 3.1 節） */
  foot?: ReactNode;
  /** `col-8` などのグリッドの幅 */
  className?: string;
  children?: ReactNode;
}

/** カード（見本の `card`）。見出しは h2 */
export function Card({ title, sub, foot, className, children }: CardProps) {
  return (
    <section className={className ? `card ${className}` : "card"}>
      {title && (
        <div className="card__head">
          <h2>{title}</h2>
          {sub && <span className="card__sub">{sub}</span>}
        </div>
      )}
      {children}
      {foot && <div className="card__foot">{foot}</div>}
    </section>
  );
}
