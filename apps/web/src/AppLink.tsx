import type { ReactNode } from "react";

import { routeToPath, withQuery, type Navigate, type Route } from "./router";
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
  query,
  className,
  children,
}: {
  route: Route;
  /** Parameters the route does not carry (`?repo=`), as `navigate`'s `query`. */
  query?: Readonly<Record<string, string>>;
  navigate: Navigate;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={withQuery(routeToPath(route), query)}
      onClick={(e) => {
        e.stopPropagation();
        if (!isPlainClick(e)) return;
        e.preventDefault();
        if (query) navigate(route, { query });
        else navigate(route);
      }}
      className={className}
    >
      {children}
    </a>
  );
}
