import { useEffect, useState } from "react";

import { readPersistedTheme, writePersistedTheme } from "./appPreferences";

export function useTheme() {
  const [theme, setTheme] = useState(readPersistedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    writePersistedTheme(theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  return { theme, toggleTheme };
}
