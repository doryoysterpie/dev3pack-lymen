/// <reference types="expo/types" />

// Where the app sends reports (E-10, app side): the base URL of the limen API, from
// EXPO_PUBLIC_API_URL. Expo inlines EXPO_PUBLIC_ variables into the bundle at build time, so
// it holds an address, never a secret. On the Android emulator the host machine's API at
// 127.0.0.1:8787 is http://10.0.2.2:8787. Unset, the app offers no report.

export const API_URL: string | null = process.env.EXPO_PUBLIC_API_URL || null;
