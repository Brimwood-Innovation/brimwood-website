export async function onRequest() {
  return new Response(JSON.stringify({ proxy: "alive" }), {
    headers: { "content-type": "application/json" },
  });
}
