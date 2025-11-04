import recipes from "Recipe.json";

export default function RecipesPage() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>☕ Cafe Recipes</h1>
      <table border="1" cellPadding="8" style={{ borderCollapse: "collapse", marginTop: 12 }}>
        <thead style={{ background: "#f0f0f0" }}>
          <tr>
            <th>Drink</th>
            <th>Ingredients</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {recipes.map((r, index) => (
            <tr key={index}>
              <td>{r.Drink}</td>
              <td>{r.Ingredients}</td>
              <td>${r.Price.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
