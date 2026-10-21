# Proxy socket mode verifier: failure modes

Recorded before the product edit, as required for an isolated socket-system
check.

1. A client connects and waits before sending its first header bytes. An
   accepted socket that inherited nonblocking mode returns `WouldBlock`; the
   worker then drops an otherwise valid proxy request.
2. The request header arrives in fragments. Resetting socket mode after the
   first read, or only on one path, still loses the request between fragments.
3. A valid header arrives but a `Content-Length` body is delayed. A mode reset
   that covers header reads but not subsequent body reads still aborts the
   upload.
4. Setting blocking mode or the existing read/write timeouts fails. Ignoring
   any setup error lets request parsing or forwarding proceed with unknown
   I/O behavior instead of closing the client connection.
5. A setup failure is reported but the socket remains queued or is forwarded;
   this can leak a connection or bypass the intended fail-closed behavior.
6. Restoring blocking mode for HTTP also leaves CONNECT sockets blocking in
   the relay. The bidirectional relay then loses its nonblocking polling,
   cancellation responsiveness, and idle handling.
7. CONNECT sets only the client side nonblocking and leaves the upstream side
   blocking, or removes either explicit mode change; the relay can stall while
   one direction has no data.
8. A delayed test exceeds the configured I/O timeout, making a correct
   blocking socket look broken. Delays must stay well below `IO_TIMEOUT`.
9. The test exercises a synthetic reader rather than the production header and
   body readers, or it never accepts a real TCP connection. Such a test would
   miss the inherited-mode behavior being fixed.
10. A passing run is not repeatable or leaves no machine-readable result, so
    reviewers cannot distinguish a successful exercise from a skipped one.
