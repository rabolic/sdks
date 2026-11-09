// The two peer modules, declared loosely: host.ts narrows them to what the SDK uses.
declare module 'react-native' {
  export const AppState: unknown
  export const Platform: unknown
  export const Dimensions: unknown
}
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: unknown
  export default AsyncStorage
}
