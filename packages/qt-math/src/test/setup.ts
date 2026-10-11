import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** Testing Library unmounts nothing by itself outside of globals mode. */
afterEach(cleanup);
