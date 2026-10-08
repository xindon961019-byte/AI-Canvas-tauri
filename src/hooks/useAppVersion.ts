import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { version } from '../../package.json';

/** 桌面使用运行中的应用版本；网页预览使用构建时的包版本。 */
export function useAppVersion(): string {
  const [appVersion, setAppVersion] = useState(version);

  useEffect(() => {
    let active = true;
    void getVersion().then((value) => {
      if (active) setAppVersion(value);
    }).catch(() => { /* 非桌面环境保留包版本。 */ });
    return () => { active = false; };
  }, []);

  return appVersion;
}
