function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePortEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
}

function resolveBackendRuntimeConfig(env = process.env) {
  return {
    ocrPort: parsePortEnv(env.BACKEND_OCR_PORT ?? env.OCR_PORT, 9003),
    enableGlobalPythonCleanup: parseBooleanEnv(env.BACKEND_GLOBAL_PYTHON_CLEANUP, true),
  };
}

module.exports = {
  parseBooleanEnv,
  parsePortEnv,
  resolveBackendRuntimeConfig,
};
