(() => {
  try {
    const theme = localStorage.getItem("momi_theme_v1");
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }
  } catch {
    // Theme boot is best-effort.
  }
})();
