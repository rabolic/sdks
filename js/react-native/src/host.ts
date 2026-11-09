/**
 * The parts of React Native and AsyncStorage the SDK uses, typed here so the
 * package builds without them installed. They are peer dependencies; the
 * defaults below are the real modules, and tests pass fakes instead.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState, Dimensions, Platform } from 'react-native'

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension'

export interface AppStateLike {
  currentState: AppStateStatus | string | null
  addEventListener(type: 'change', listener: (state: AppStateStatus | string) => void): { remove(): void }
}

export interface PlatformLike {
  OS: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string
  Version: string | number
  isPad?: boolean
  constants?: { Model?: string; Manufacturer?: string; Brand?: string; osVersion?: string }
}

export interface DimensionsLike {
  get(dim: 'screen' | 'window'): { width: number; height: number; scale: number }
}

export interface Host {
  storage: AsyncStorageLike
  appState: AppStateLike
  platform: PlatformLike
  dimensions: DimensionsLike
}

export const reactNativeHost = (): Host => ({
  storage: AsyncStorage as unknown as AsyncStorageLike,
  appState: AppState as unknown as AppStateLike,
  platform: Platform as unknown as PlatformLike,
  dimensions: Dimensions as unknown as DimensionsLike,
})
