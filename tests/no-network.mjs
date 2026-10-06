// Import this FIRST in any test that touches code which can make HTTP calls (settings, image generation).
// It makes every outbound fetch throw, so no test can ever reach Azure or any other real service.
// Tests that need HTTP behaviour must pass their own fake fetch into the code under test.
export const blockedCalls = [];

globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input?.url;
  blockedCalls.push(url);
  throw new Error(`Network access is blocked in tests (attempted: ${url})`);
};
