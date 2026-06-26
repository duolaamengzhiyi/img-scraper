import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 className，处理 Tailwind 冲突 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
