import type { ReactNode } from "react";

import { routeToPath, type Navigate, type Route } from "./router";
import { isPlainClick } from "./ui";

/**
 * A page of the app as a real link: its `href` is the route's address, so a
 * middle click or a modified one opens a tab; a plain click routes in place.
 * It stops the click there: a link in a clickable row opens its own page,
 * not the row's. The look is the caller's (`className`).
 */
export function AppLink({
  route,
  navigate,
  className,
  children,
}: {
  route: Route;
  navigate: Navigate;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={routeToPath(route)}
      onClick={(e) => {
        e.stopPropagation();
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(route);
      }}
      className={className}
    >
      {children}
    </a>
  );
}
