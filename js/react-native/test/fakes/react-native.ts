// Stand-ins for the real modules, which need a React Native runtime. Tests pass their own host.
export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) }
export const Platform = { OS: 'ios', Version: '18.1' }
export const Dimensions = { get: () => ({ width: 393, height: 852, scale: 3 }) }
