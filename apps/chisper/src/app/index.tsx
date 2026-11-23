import { ConfigProvider } from 'antd';
import { StyleSheetManager } from 'styled-components';
import { TIP_DELAY } from '@chisper/ui-kit';
import { App } from './app';
import Synth from './synth';

export function Core() {
  // the vendor prefixes of the CSS, which styled-components added before v6 (it adds none by default since)
  return (
    <StyleSheetManager enableVendorPrefixes>
      <ConfigProvider
        // a tooltip waits as those of the keys of the synth: passing over the page shows none
        tooltip={{ mouseEnterDelay: TIP_DELAY / 1000 }}
        theme={{
          token: {
            borderRadius: 0,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            sizePopupArrow: 0,
            boxShadowSecondary: '',
          },
        }}
      >
        <App>
          <Synth />
        </App>
      </ConfigProvider>
    </StyleSheetManager>
  );
}
