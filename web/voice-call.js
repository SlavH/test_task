import { RetellWebClient } from "retell-client-js-sdk";

function friendlyError(error) {
  const name = error?.name || "";
  const text = String(error?.message || error || "");
  if (name === "NotAllowedError" || /permission|denied/i.test(text)) {
    return "Microphone access was blocked. Allow microphone access in your browser, then try again.";
  }
  if (name === "NotFoundError" || /no.*microphone|device not found/i.test(text)) {
    return "No microphone was found. Connect a microphone or headset, then try again.";
  }
  if (/agent.*not.*found|not.*provisioned|404/i.test(text)) {
    return "The voice agent is not available yet. Check the Retell configuration.";
  }
  if (/network|failed to fetch|connection/i.test(text)) {
    return "The call could not connect. Check your connection and try again.";
  }
  return text || "The call could not start. Please try again.";
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone calls.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

export async function startVoiceDemo({
  name = "",
  onStatus = () => {},
  onTalking = () => {},
  onEnd = () => {},
  onError = () => {},
} = {}) {
  try {
    await requestMicrophone();
  } catch (error) {
    const message = friendlyError(error);
    onError(message);
    throw new Error(message);
  }

  let response;
  try {
    response = await fetch("/api/web-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    const message = "Could not reach the call server. Please try again.";
    onError(message);
    throw new Error(message);
  }

  const details = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      details.message || "The call could not be created. Please try again.";
    onError(message);
    throw new Error(message);
  }

  const client = new RetellWebClient();
  let ended = false;
  let hasStarted = false;
  let reportedError = false;
  let startedResolve;
  let startedReject;
  const started = new Promise((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });

  const reportError = (error) => {
    if (reportedError) return;
    reportedError = true;
    onError(friendlyError(error));
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    onTalking(false);
    if (!hasStarted) {
      startedReject(new Error("The call ended before it connected."));
      return;
    }
    onEnd();
  };

  client.on("call_started", () => {
    hasStarted = true;
    onStatus("live");
    startedResolve();
  });
  client.on("call_ready", () => {
    onStatus("live");
  });
  client.on("call_ended", finish);
  client.on("agent_start_talking", () => onTalking(true));
  client.on("agent_stop_talking", () => onTalking(false));
  client.on("error", (error) => {
    reportError(error);
    finish();
  });

  const timeout = setTimeout(() => {
    reportError(new Error("The call timed out while connecting. Please try again."));
    startedReject(new Error("The call timed out while connecting. Please try again."));
    client.stopCall();
  }, 20000);

  try {
    await client.startCall({
      callId: details.call_id,
      accessToken: details.access_token,
      transport: details.transport,
      iceServers: details.ice_servers,
      url: details.url,
      sampleRate: details.sample_rate,
      baseURL: `${window.location.origin}/api/retell-proxy`,
    });
    await started;
  } catch (error) {
    clearTimeout(timeout);
    reportError(error);
    client.stopCall();
    throw new Error(friendlyError(error));
  }
  clearTimeout(timeout);

  return {
    callId: details.call_id,
    mute() {
      client.mute();
    },
    unmute() {
      client.unmute();
    },
    stop() {
      try {
        client.stopCall();
      } finally {
        finish();
      }
    },
  };
}
