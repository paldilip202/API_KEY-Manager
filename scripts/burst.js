const key = process.argv[2];

(async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch('http://localhost:3000/read/hello', {
        headers: { Authorization: `Bearer ${key}` },
      }).then((r) => r.status)
    )
  );
  const counts = {};
  results.forEach((s) => (counts[s] = (counts[s] || 0) + 1));
  console.log(counts);
})();