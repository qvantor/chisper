import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { Key, ToastAsk } from '../../../common/components';
import { useSynthCore } from '../../common/modules';

const LIMITER_TOAST = 'limiter-failed';

// the synth is silent without its master limiter (master-limiter.ts): a failed one shows a toast on every
// screen until it loads again, its Retry loads it (with the oscillators, if they failed too). An unsupported
// one isn't shown: the oscillators need the same, they tell why over their waves (OscillatorStatus). Renders
// nothing
export const LimiterStatus = () => {
  const [{ masterLimiter }, { retryAudio }] = useSynthCore();
  const failed = useBehaviorSubject(masterLimiter.$status) === 'failed';

  useEffect(() => {
    if (!failed) return undefined;
    toast.error(
      <ToastAsk text='No sound: the master limiter failed'>
        <Key onClick={retryAudio}>Retry</Key>
      </ToastAsk>,
      { id: LIMITER_TOAST, duration: Infinity }
    );
    return () => toast.dismiss(LIMITER_TOAST);
  }, [failed, retryAudio]);

  return null;
};
