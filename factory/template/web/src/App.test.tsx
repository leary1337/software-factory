import { render, screen } from "@testing-library/react";
import { App } from "./App";

test("shows the API status", () => {
  render(<App />);
  expect(screen.getByText("API status: unknown")).toBeDefined();
});
