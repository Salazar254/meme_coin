from run_million_scenario_tests import (
    EventDataGenerator,
    HighVolumeScenarioRunner,
    ScenarioConfig,
)


def test_run_scenario_returns_summary_for_quick_dataset():
    events = EventDataGenerator(seed=123).generate_events(200)
    runner = HighVolumeScenarioRunner(seed=123)

    result = runner.run_scenario(
        events,
        ScenarioConfig(name="A_QuickTest", description="Regression test"),
    )

    assert result["scenario"] == "A_QuickTest"
    assert "realism_flag" in result
    assert "warnings" in result
    assert result["num_trades"] >= 0
